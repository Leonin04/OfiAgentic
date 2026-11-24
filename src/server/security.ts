import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AgentEngine, EngineInfo } from '../shared/protocol.js';

export const ALLOWED_ENGINES: readonly AgentEngine[] = ['agy', 'claude', 'codex', 'gemini'];

const ENGINE_LABELS: Record<AgentEngine, string> = {
  agy: 'Antigravity CLI (agy)',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI'
};

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'ofi_sid';
const MAX_BODY_BYTES = 262_144;

export interface BrowserSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

interface RateBucket {
  timestamps: number[];
}

export function maskSensitiveText(raw: string): string {
  if (!raw) return '';
  let masked = raw;
  // JWTs
  masked = masked.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[JWT_REDACTED]');
  // Bearer tokens
  masked = masked.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  // Well-known key prefixes
  masked = masked.replace(/\b(sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[KEY_REDACTED]');
  // Key/Value secrets
  masked = masked.replace(
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*([=:])\s*(['"]?)([^\s'"]{4,})\3/gi,
    '$1$2[REDACTED]'
  );
  // Email masking
  masked = masked.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***$2');
  // Long credit-card / SSN-like numeric sequences (12-19 digits)
  masked = masked.replace(/\b(?:\d[ -]*?){12,19}\b/g, '[NUM_REDACTED]');
  return masked;
}

export function sanitizeLabel(raw: string, maxLen = 64): string {
  const cleaned = raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.slice(0, maxLen);
}

export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{1,96}$/.test(id);
}

export function validateDirectoryBoundary(targetPath: string, allowedRoot: string): string | null {
  if (!targetPath || typeof targetPath !== 'string') return null;
  if (targetPath.includes('\0')) return null;

  const resolvedRoot = path.resolve(allowedRoot);
  const resolvedTarget = path.resolve(resolvedRoot, targetPath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }

  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    if (!fs.existsSync(resolvedTarget)) {
      return resolvedTarget;
    }
    const realTarget = fs.realpathSync(resolvedTarget);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      return null;
    }
    return realTarget;
  } catch {
    return null;
  }
}

export function validateAllowedAgentDir(targetPath: string, allowedRoots: readonly string[]): string | null {
  // TODO(security): Enforce OS/container namespace isolation per spawned agent if ever deployed in a multi-tenant environment.
  if (!targetPath || typeof targetPath !== 'string' || targetPath.length > 1024) return null;
  if (targetPath.includes('\0')) return null;

  const trimmed = targetPath.trim();
  if (!trimmed || allowedRoots.length === 0) return null;

  let expanded = trimmed;
  if (trimmed === '~') {
    expanded = os.homedir();
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    expanded = path.join(os.homedir(), trimmed.slice(2));
  }

  const baseForRelative = path.resolve(allowedRoots[0]);
  const candidate = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseForRelative, expanded);

  for (const root of allowedRoots) {
    const validated = validateDirectoryBoundary(candidate, root);
    if (!validated) continue;
    try {
      if (fs.existsSync(validated) && fs.statSync(validated).isDirectory()) {
        return validated;
      }
    } catch {
      // fail closed on stat error
    }
  }

  return null;
}

export function listSubdirectories(
  dirPath: string,
  allowedRoots: readonly string[]
): { currentPath: string; parentPath: string | null; directories: Array<{ name: string; path: string }> } | null {
  const safeDir = validateAllowedAgentDir(dirPath, allowedRoots);
  if (!safeDir) return null;

  const parentCandidate = path.dirname(safeDir);
  const parentPath =
    parentCandidate !== safeDir ? validateAllowedAgentDir(parentCandidate, allowedRoots) : null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(safeDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const directories: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const resolvedChild = validateAllowedAgentDir(path.join(safeDir, entry.name), allowedRoots);
    if (resolvedChild) {
      directories.push({ name: entry.name, path: resolvedChild });
    }
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  return {
    currentPath: safeDir,
    parentPath,
    directories: directories.slice(0, 200)
  };
}

export function resolveAllowedBinary(engine: AgentEngine): string | null {
  if (!ALLOWED_ENGINES.includes(engine)) return null;
  const candidateDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin'
  ];
  for (const dir of candidateDirs) {
    const fullPath = path.join(dir, engine);
    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        return fullPath;
      }
    } catch {
      // continue searching trusted directories
    }
  }
  return null;
}

export function getAvailableEngines(): EngineInfo[] {
  return ALLOWED_ENGINES.map((id) => ({
    id,
    label: ENGINE_LABELS[id],
    available: resolveAllowedBinary(id) !== null
  }));
}

export function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export interface SecurityOptions {
  workspaceRoot: string;
  port: number;
  devClientPort?: number;
  writeHomeRuntime?: boolean;
}

export class SecurityManager {
  readonly workspaceRoot: string;
  port: number;
  readonly devClientPort: number;
  readonly sessionSecret: string;
  readonly hookToken: string;
  private readonly trustedOrigins: Set<string>;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(options: SecurityOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.port = options.port;
    this.devClientPort = options.devClientPort ?? 5173;

    this.trustedOrigins = new Set([
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
      `http://[::1]:${this.port}`
    ]);
    for (let p = this.devClientPort; p <= this.devClientPort + 5; p += 1) {
      this.trustedOrigins.add(`http://127.0.0.1:${p}`);
      this.trustedOrigins.add(`http://localhost:${p}`);
      this.trustedOrigins.add(`http://[::1]:${p}`);
    }
    for (let p = 5173; p <= 5178; p += 1) {
      this.trustedOrigins.add(`http://127.0.0.1:${p}`);
      this.trustedOrigins.add(`http://localhost:${p}`);
      this.trustedOrigins.add(`http://[::1]:${p}`);
    }

    if (process.env.OFI_SESSION_SECRET && process.env.OFI_SESSION_SECRET.length >= 32) {
      this.sessionSecret = process.env.OFI_SESSION_SECRET;
    } else {
      console.warn('[security] Generating ephemeral instance-isolated session secret.');
      this.sessionSecret = crypto.randomBytes(32).toString('hex');
    }

    if (process.env.OFI_HOOK_TOKEN && process.env.OFI_HOOK_TOKEN.length >= 32) {
      this.hookToken = process.env.OFI_HOOK_TOKEN;
    } else {
      console.warn('[security] Generating ephemeral instance-isolated hook token.');
      this.hookToken = crypto.randomBytes(32).toString('hex');
    }

    this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
    this.pruneTimer.unref();
  }

  dispose(): void {
    clearInterval(this.pruneTimer);
    this.sessions.clear();
    this.rateBuckets.clear();
  }

  registerListeningPort(actualPort: number): void {
    this.port = actualPort;
    this.trustedOrigins.add(`http://127.0.0.1:${actualPort}`);
    this.trustedOrigins.add(`http://localhost:${actualPort}`);
    this.trustedOrigins.add(`http://[::1]:${actualPort}`);
  }

  writeRuntimeFiles(actualPort: number, includeHome = true): string {
    const payload = JSON.stringify(
      {
        port: actualPort,
        hookToken: this.hookToken,
        pid: process.pid,
        workspaceRoot: this.workspaceRoot,
        updatedAt: Date.now()
      },
      null,
      2
    );

    const localDir = path.join(this.workspaceRoot, '.ofiagentic');
    fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
    const localFile = path.join(localDir, 'runtime.json');
    fs.writeFileSync(localFile, payload, { mode: 0o600 });
    try {
      fs.chmodSync(localFile, 0o600);
    } catch {
      // ignore on platforms without POSIX chmod
    }

    if (includeHome) {
      try {
        const homeDir = path.join(os.homedir(), '.ofiagentic');
        fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
        const homeFile = path.join(homeDir, 'runtime.json');
        fs.writeFileSync(homeFile, payload, { mode: 0o600 });
        fs.chmodSync(homeFile, 0o600);
      } catch {
        // Best-effort outside workspace; ignore inside restricted sandboxes
      }
    }

    return localFile;
  }

  isTrustedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    return this.trustedOrigins.has(origin);
  }

  getTrustedOriginsList(): string[] {
    return Array.from(this.trustedOrigins);
  }

  applySecurityHeaders(res: http.ServerResponse, isApi: boolean, devMode = false): void {
    const wsSet = new Set([
      `ws://127.0.0.1:${this.port}`,
      `ws://localhost:${this.port}`,
      `ws://[::1]:${this.port}`
    ]);
    for (let p = this.devClientPort; p <= this.devClientPort + 5; p += 1) {
      wsSet.add(`ws://127.0.0.1:${p}`);
      wsSet.add(`ws://localhost:${p}`);
      wsSet.add(`ws://[::1]:${p}`);
    }
    for (let p = 5173; p <= 5178; p += 1) {
      wsSet.add(`ws://127.0.0.1:${p}`);
      wsSet.add(`ws://localhost:${p}`);
      wsSet.add(`ws://[::1]:${p}`);
    }
    const wsSources = Array.from(wsSet).join(' ');

    if (!devMode || isApi) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src 'self' ${wsSources}`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'"
      ].join('; ');

      res.setHeader('Content-Security-Policy', csp);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (isApi) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }

  getSessionFromRequest(req: http.IncomingMessage): BrowserSession | null {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sid);
      return null;
    }
    return session;
  }

  getOrCreateSession(req: http.IncomingMessage, res: http.ServerResponse): BrowserSession {
    const existing = this.getSessionFromRequest(req);
    if (existing) return existing;

    const now = Date.now();
    const session: BrowserSession = {
      id: crypto.randomBytes(24).toString('hex'),
      csrfToken: crypto.randomBytes(24).toString('hex'),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    };
    this.sessions.set(session.id, session);

    // TODO(security): Enforce TLS + __Host- cookie prefix, OAuth/MFA if ever exposed beyond single-user 127.0.0.1 loopback.
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
    );
    return session;
  }

  invalidateSession(req: http.IncomingMessage, res: http.ServerResponse): void {
    const existing = this.getSessionFromRequest(req);
    if (existing) {
      this.sessions.delete(existing.id);
    }
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    );
  }

  verifyBrowserPost(req: http.IncomingMessage): { ok: true; session: BrowserSession } | { ok: false; status: number; reason: string } {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const secFetchSite = typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined;

    if (origin) {
      if (!this.isTrustedOrigin(origin)) {
        return { ok: false, status: 403, reason: 'Untrusted origin' };
      }
    } else if (secFetchSite !== 'same-origin') {
      return { ok: false, status: 403, reason: 'Missing Origin header' };
    }

    const session = this.getSessionFromRequest(req);
    if (!session) {
      return { ok: false, status: 403, reason: 'Invalid or expired session' };
    }

    const csrfHeader = req.headers['x-csrf-token'];
    if (typeof csrfHeader !== 'string' || !timingSafeEquals(csrfHeader, session.csrfToken)) {
      return { ok: false, status: 403, reason: 'Invalid CSRF token' };
    }

    return { ok: true, session };
  }

  verifyHookAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string') return false;
    if (!authHeader.startsWith('Bearer ')) return false;
    const provided = authHeader.slice(7).trim();
    if (!provided) return false;
    return timingSafeEquals(provided, this.hookToken);
  }

  checkRateLimit(bucketName: string, clientKey: string, maxRequests: number, windowMs: number): boolean {
    const key = `${bucketName}:${clientKey}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = this.rateBuckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.rateBuckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);
    if (bucket.timestamps.length >= maxRequests) {
      return false;
    }
    bucket.timestamps.push(now);
    return true;
  }

  async readJsonBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > maxBytes) {
          aborted = true;
          reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) {
          resolve({});
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(Object.assign(new Error('JSON body must be an object'), { statusCode: 400 }));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 }));
        }
      });

      req.on('error', (err) => {
        if (!aborted) {
          reject(Object.assign(err, { statusCode: 400 }));
        }
      });
    });
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
    for (const [key, bucket] of this.rateBuckets.entries()) {
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > now - 120_000);
      if (bucket.timestamps.length === 0) {
        this.rateBuckets.delete(key);
      }
    }
  }
}
