import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  AgentEngine,
  AgentExecutionMode,
  AgentRole,
  ClientWsMessage,
  ServerWsMessage
} from '../shared/protocol.js';
import { AgentSpawner } from './agentSpawner.js';
import { AgyTranscriptWatcher } from './agyWatcher.js';
import { DemoSimulator } from './demoSimulator.js';
import { HookBridge } from './hookBridge.js';
import {
  ALLOWED_ENGINES,
  getAvailableEngines,
  isSafeId,
  listSubdirectories,
  SecurityManager,
  validateDirectoryBoundary
} from './security.js';
import { StateManager } from './stateManager.js';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

interface WsClientMeta {
  authenticated: boolean;
  csrfToken: string;
  authTimer: NodeJS.Timeout;
}

export interface OfiServerOptions {
  port?: number;
  workspaceRoot?: string;
  allowedAgentRoots?: string[];
  devClientPort?: number;
  devMode?: boolean;
  writeHomeRuntime?: boolean;
  coffeeTimeoutMs?: number;
  leavingTimeoutMs?: number;
  bossRequestTimeoutMs?: number;
}

export interface OfiServerInstance {
  httpServer: http.Server;
  port: number;
  security: SecurityManager;
  state: StateManager;
  spawner: AgentSpawner;
  watcher: AgyTranscriptWatcher;
  demo: DemoSimulator;
  runtimeFilePath: string;
  close: () => Promise<void>;
}

export async function createOfiServer(options: OfiServerOptions = {}): Promise<OfiServerInstance> {
  const port = options.port ?? Number(process.env.OFI_PORT || 4317);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const homeDir = os.homedir();
  const allowedAgentRoots =
    options.allowedAgentRoots && options.allowedAgentRoots.length > 0
      ? options.allowedAgentRoots.map((r) => path.resolve(r))
      : Array.from(new Set([workspaceRoot, homeDir]));
  const devClientPort = options.devClientPort ?? Number(process.env.OFI_CLIENT_PORT || 5173);
  const devMode = options.devMode ?? process.argv.includes('--dev');
  const distClientDir = path.resolve(workspaceRoot, 'dist', 'client');

  const security = new SecurityManager({
    workspaceRoot,
    port,
    devClientPort,
    writeHomeRuntime: options.writeHomeRuntime
  });

  const wsClients = new Map<WebSocket, WsClientMeta>();
  const broadcast = (message: ServerWsMessage): void => {
    const encoded = JSON.stringify(message);
    for (const [socket, meta] of wsClients.entries()) {
      if (meta.authenticated && socket.readyState === WebSocket.OPEN) {
        socket.send(encoded);
      }
    }
  };

  let spawnerRef: AgentSpawner | null = null;
  const state = new StateManager({
    coffeeTimeoutMs: options.coffeeTimeoutMs,
    leavingTimeoutMs: options.leavingTimeoutMs,
    bossRequestTimeoutMs: options.bossRequestTimeoutMs,
    hasUiClients: () => {
      for (const [socket, meta] of wsClients.entries()) {
        if (meta.authenticated && socket.readyState === WebSocket.OPEN) return true;
      }
      return false;
    },
    onStopProcess: (agent) => {
      if (agent.source === 'web' || agent.isolatedPid) {
        spawnerRef?.stopTurn(agent.id);
      }
    },
    onFireProcess: (agent) => {
      if (agent.source === 'web' || agent.isolatedPid) {
        spawnerRef?.killAgent(agent.id, agent.isolatedPid);
      } else if (agent.source === 'custom' && agent.hostPid && agent.hostPid > 1 && agent.hostPid !== process.pid) {
        // Only terminate dedicated single-agent `ofi wrap` processes, never shared CLI coordinators
        const otherSharing = state.getAllAgents().some((other) => other.id !== agent.id);
        if (!otherSharing || agent.source === 'custom') {
          try {
            process.kill(agent.hostPid, 'SIGTERM');
          } catch {
            // ignore if already exited
          }
        }
      }
    },
    onBroadcast: broadcast
  });

  const watcher = new AgyTranscriptWatcher(state);
  const hookBridge = new HookBridge(state, watcher);
  const demo = new DemoSimulator(state);

  let viteServer: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse, next?: () => void) => void; close: () => Promise<void> } | null = null;

  const httpServer = http.createServer(async (req, res) => {
    const urlStr = req.url || '/';
    const urlObj = new URL(urlStr, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const isApi = pathname.startsWith('/api/');

    security.applySecurityHeaders(res, isApi, devMode);

    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    try {
      // ─── Session & Public Read Endpoints ──────────────────────────────────
      if (method === 'GET' && pathname === '/api/session') {
        const session = security.getOrCreateSession(req, res);
        sendJson(res, 200, {
          csrfToken: session.csrfToken,
          workspaceRoot,
          homeDir,
          availableEngines: getAvailableEngines(),
          bossGateEnabled: state.getBossGateEnabled(),
          demoRunning: demo.isRunning()
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/fs/dirs') {
        if (!security.checkRateLimit('browser', clientIp, 180, 60_000)) {
          sendJson(res, 429, { error: 'Rate limit exceeded' });
          return;
        }
        const session = security.getSessionFromRequest(req);
        if (!session) {
          sendJson(res, 403, { error: 'Invalid or expired session' });
          return;
        }
        const requestedPath = urlObj.searchParams.get('path') || workspaceRoot;
        const listing = listSubdirectories(requestedPath, allowedAgentRoots);
        if (!listing) {
          sendJson(res, 400, { error: 'La carpeta no existe o está fuera del límite permitido.' });
          return;
        }
        sendJson(res, 200, {
          ...listing,
          workspaceRoot,
          homeDir
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/session/logout') {
        const auth = security.verifyBrowserPost(req);
        if (!auth.ok) {
          sendJson(res, auth.status, { error: auth.reason });
          return;
        }
        security.invalidateSession(req, res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, {
          agents: state.getAllAgents(),
          bossQueue: state.getBossQueue(),
          metrics: state.getMetrics(),
          availableEngines: getAvailableEngines(),
          bossGateEnabled: state.getBossGateEnabled(),
          demoRunning: demo.isRunning()
        });
        return;
      }

      // ─── Hook / CLI Ingestion Endpoints (Bearer hookToken) ────────────────
      if (method === 'POST' && pathname.startsWith('/api/hooks/')) {
        if (!security.verifyHookAuth(req)) {
          sendJson(res, 401, { error: 'Unauthorized hook token' });
          return;
        }
        if (!security.checkRateLimit('hooks', clientIp, 600, 60_000)) {
          sendJson(res, 429, { error: 'Too many hook events' });
          return;
        }
        const provider = pathname.slice('/api/hooks/'.length);
        if (provider !== 'agy' && provider !== 'claude') {
          sendJson(res, 404, { error: 'Unknown hook provider' });
          return;
        }
        const body = await security.readJsonBody(req);
        const result = await hookBridge.handleHook(provider, body);
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/events') {
        if (!security.verifyHookAuth(req)) {
          sendJson(res, 401, { error: 'Unauthorized event token' });
          return;
        }
        if (!security.checkRateLimit('hooks', clientIp, 600, 60_000)) {
          sendJson(res, 429, { error: 'Too many events' });
          return;
        }
        const body = await security.readJsonBody(req);
        const result = hookBridge.handleCustomEvent(body);
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && pathname.startsWith('/api/agent-status/')) {
        if (!security.verifyHookAuth(req)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        const rawId = decodeURIComponent(pathname.slice('/api/agent-status/'.length));
        if (!isSafeId(rawId)) {
          sendJson(res, 400, { error: 'Invalid agent ID' });
          return;
        }
        sendJson(res, 200, {
          fired: state.isFired(rawId),
          agent: state.findAgent(rawId) ?? null
        });
        return;
      }

      // ─── Browser Control Endpoints (Origin + Cookie + CSRF) ───────────────
      if (method === 'POST' && isApi) {
        if (!security.checkRateLimit('browser', clientIp, 180, 60_000)) {
          sendJson(res, 429, { error: 'Rate limit exceeded' });
          return;
        }

        const auth = security.verifyBrowserPost(req);
        if (!auth.ok) {
          sendJson(res, auth.status, { error: auth.reason });
          return;
        }

        const body = await security.readJsonBody(req);

        if (pathname === '/api/agents/hire') {
          const engine = typeof body.engine === 'string' && ALLOWED_ENGINES.includes(body.engine as AgentEngine)
            ? (body.engine as AgentEngine)
            : null;
          if (!engine) {
            sendJson(res, 400, { error: 'Motor inválido.' });
            return;
          }
          const role: AgentRole =
            body.role === 'coordinator' || body.role === 'researcher' || body.role === 'builder'
              ? body.role
              : 'builder';
          const mode: AgentExecutionMode =
            body.mode === 'accept-edits' || body.mode === 'plan' || body.mode === 'auto' || body.mode === 'default'
              ? body.mode
              : 'default';
          const name = typeof body.name === 'string' ? body.name : '';
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
          const skipPermissions = typeof body.skipPermissions === 'boolean' ? body.skipPermissions : true;

          if (!spawnerRef) {
            sendJson(res, 503, { error: 'Spawner no inicializado.' });
            return;
          }
          const result = spawnerRef.hireAgent({ name, engine, role, mode, prompt, cwd, skipPermissions });
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 201, { agent: result.agent });
          return;
        }

        const stopMatch = /^\/api\/agents\/([^/]+)\/stop$/.exec(pathname);
        if (stopMatch) {
          const id = decodeURIComponent(stopMatch[1]);
          if (!isSafeId(id)) {
            sendJson(res, 400, { error: 'ID de empleado inválido' });
            return;
          }
          const result = state.stopAgentTurn(id);
          if (!result.ok) {
            sendJson(res, 404, { error: result.reason });
            return;
          }
          sendJson(res, 200, { ok: true, agentId: result.agentId });
          return;
        }

        const fireMatch = /^\/api\/agents\/([^/]+)\/fire$/.exec(pathname);
        if (fireMatch) {
          const id = decodeURIComponent(fireMatch[1]);
          if (!isSafeId(id)) {
            sendJson(res, 400, { error: 'ID de empleado inválido' });
            return;
          }
          const result = state.fireAgent(id);
          if (!result.ok) {
            sendJson(res, 404, { error: result.reason });
            return;
          }
          sendJson(res, 200, { ok: true, agentId: result.agentId });
          return;
        }

        const promptMatch = /^\/api\/agents\/([^/]+)\/prompt$/.exec(pathname);
        if (promptMatch) {
          const id = decodeURIComponent(promptMatch[1]);
          if (!isSafeId(id)) {
            sendJson(res, 400, { error: 'ID de empleado inválido' });
            return;
          }
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          if (!spawnerRef) {
            sendJson(res, 503, { error: 'Spawner no inicializado.' });
            return;
          }
          const result = spawnerRef.sendPrompt(id, prompt);
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/boss/respond') {
          const requestId = typeof body.requestId === 'string' ? body.requestId : '';
          const decision = body.decision === 'allow' || body.decision === 'deny' ? body.decision : null;
          const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined;
          if (!isSafeId(requestId) || !decision) {
            sendJson(res, 400, { error: 'Solicitud inválida' });
            return;
          }
          const handled = state.respondToBossRequest(requestId, decision, note);
          if (!handled) {
            sendJson(res, 404, { error: 'La petición ya expiró o fue resuelta.' });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (pathname === '/api/settings/boss-gate') {
          const enabled = Boolean(body.enabled);
          state.setBossGateEnabled(enabled);
          sendJson(res, 200, { bossGateEnabled: state.getBossGateEnabled() });
          return;
        }

        if (pathname === '/api/demo/toggle') {
          const running = demo.toggle();
          sendJson(res, 200, { demoRunning: running });
          return;
        }

        sendJson(res, 404, { error: 'Endpoint not found' });
        return;
      }

      if (isApi) {
        sendJson(res, 404, { error: 'Endpoint not found' });
        return;
      }

      // ─── Vite Dev Middleware or Static Production Build ───────────────────
      if (viteServer) {
        viteServer.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end('Not found');
        });
      } else if (fs.existsSync(distClientDir)) {
        serveStaticFile(distClientDir, pathname, res);
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('OfiAgentic backend running. Run npm run dev or npm run build.');
      }
    } catch (err) {
      const status = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
      const msg = status >= 500 ? 'Internal server error' : (err instanceof Error ? err.message : 'Bad request');
      if (status >= 500) {
        console.error('[server] Unexpected request error:', err);
      }
      sendJson(res, status, { error: msg });
    }
  });

  // ─── Authenticated WebSocket Server (Origin + Session + CSRF Auth Frame) ───
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

  httpServer.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (devMode && reqUrl.pathname === '/__vite_hmr') {
      // Allow Vite HMR websocket upgrade handler attached to httpServer
      return;
    }
    if (reqUrl.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!security.isTrustedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = security.getSessionFromRequest(req);
    if (!session) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, session.csrfToken);
    });
  });

  wss.on('connection', (ws: WebSocket, expectedCsrf: string) => {
    const authTimer = setTimeout(() => {
      const meta = wsClients.get(ws);
      if (meta && !meta.authenticated) {
        ws.close(4001, 'Auth timeout');
      }
    }, 5_000);
    authTimer.unref();

    wsClients.set(ws, {
      authenticated: false,
      csrfToken: expectedCsrf,
      authTimer
    });

    ws.on('message', (data) => {
      const meta = wsClients.get(ws);
      if (!meta) return;

      let msg: ClientWsMessage;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientWsMessage;
      } catch {
        ws.close(4002, 'Invalid JSON');
        return;
      }

      if (!meta.authenticated) {
        if (msg.type === 'auth' && typeof msg.csrfToken === 'string' && msg.csrfToken === meta.csrfToken) {
          clearTimeout(meta.authTimer);
          meta.authenticated = true;
          ws.send(JSON.stringify({ type: 'auth_ok' } satisfies ServerWsMessage));
          ws.send(
            JSON.stringify({
              type: 'state_sync',
              agents: state.getAllAgents(),
              bossQueue: state.getBossQueue(),
              metrics: state.getMetrics(),
              availableEngines: getAvailableEngines(),
              bossGateEnabled: state.getBossGateEnabled(),
              demoRunning: demo.isRunning()
            } satisfies ServerWsMessage)
          );
        } else {
          ws.close(4003, 'Unauthorized');
        }
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'metrics', metrics: state.getMetrics() } satisfies ServerWsMessage));
      }
    });

    ws.on('close', () => {
      const meta = wsClients.get(ws);
      if (meta) {
        clearTimeout(meta.authTimer);
        wsClients.delete(ws);
      }
    });
  });

  // Always bind strictly to loopback 127.0.0.1 (never 0.0.0.0)
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  security.registerListeningPort(actualPort);
  const runtimeFilePath = security.writeRuntimeFiles(actualPort, options.writeHomeRuntime ?? true);
  spawnerRef = new AgentSpawner(state, workspaceRoot, runtimeFilePath, allowedAgentRoots);

  if (devMode) {
    const vite = await import('vite');
    viteServer = await vite.createServer({
      configFile: path.resolve(workspaceRoot, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
          path: '/__vite_hmr'
        }
      },
      appType: 'spa'
    });
  }

  const close = async (): Promise<void> => {
    demo.stop();
    spawnerRef?.dispose();
    watcher.dispose();
    state.dispose();
    security.dispose();
    for (const [ws, meta] of wsClients.entries()) {
      clearTimeout(meta.authTimer);
      ws.close();
    }
    wsClients.clear();
    wss.close();
    if (viteServer) {
      await viteServer.close();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  return {
    httpServer,
    port: actualPort,
    security,
    state,
    spawner: spawnerRef,
    watcher,
    demo,
    runtimeFilePath,
    close
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function serveStaticFile(distDir: string, reqPath: string, res: http.ServerResponse): void {
  const cleanRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const safePath = validateDirectoryBoundary(cleanRel, distDir);
  let targetFile = safePath;

  if (!targetFile || !fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(distDir, 'index.html');
  }

  const ext = path.extname(targetFile).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', STATIC_MIME[ext] || 'application/octet-stream');
  fs.createReadStream(targetFile).pipe(res);
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  createOfiServer()
    .then((instance) => {
      console.log(`🏢 OfiAgentic server listening on http://127.0.0.1:${instance.port}`);
      const onSignal = () => {
        void instance.close().then(() => process.exit(0));
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
    })
    .catch((err) => {
      console.error('[server] Failed to start:', err);
      process.exit(1);
    });
}
