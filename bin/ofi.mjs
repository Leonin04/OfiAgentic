#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findRuntimeInfo(startDir = process.cwd()) {
  const envFile = process.env.OFI_RUNTIME_FILE;
  if (envFile && fs.existsSync(envFile)) {
    try {
      return JSON.parse(fs.readFileSync(envFile, 'utf8'));
    } catch {
      // continue searching
    }
  }

  let dir = path.resolve(startDir);
  for (let i = 0; i < 16; i += 1) {
    const candidate = path.join(dir, '.ofiagentic', 'runtime.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch {
        // continue
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const homeCandidate = path.join(os.homedir(), '.ofiagentic', 'runtime.json');
  if (fs.existsSync(homeCandidate)) {
    try {
      return JSON.parse(fs.readFileSync(homeCandidate, 'utf8'));
    } catch {
      // ignore
    }
  }
  return null;
}

async function postJson(runtime, endpoint, body, timeoutMs = 16_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtime.hookToken}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(runtime, endpoint, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}${endpoint}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${runtime.hookToken}`
      },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function handleHook(provider) {
  const raw = await readStdin();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  if (process.env.OFI_AGENT_ID && !payload.ofiAgentId) {
    payload.ofiAgentId = process.env.OFI_AGENT_ID;
  }

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const runtime = findRuntimeInfo(cwd);
  const eventName = payload.hookEventName || payload.hook_event_name || '';

  if (!runtime || !runtime.port || !runtime.hookToken) {
    process.stdout.write(eventName === 'PreToolUse' ? '{"decision":"ask"}\n' : '{}\n');
    return;
  }

  const result = await postJson(runtime, `/api/hooks/${provider}`, payload, 16_000);
  if (!result) {
    process.stdout.write(eventName === 'PreToolUse' ? '{"decision":"ask"}\n' : '{}\n');
    return;
  }

  if (provider === 'agy' && eventName === 'PreToolUse' && (typeof result.decision !== 'string' || !result.decision)) {
    process.stdout.write('{"decision":"ask"}\n');
    return;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function handleEmit(args) {
  const opts = parseFlags(args);
  const runtime = findRuntimeInfo(process.cwd());
  if (!runtime) return;

  await postJson(runtime, '/api/events', {
    id: opts.id || `custom_${process.pid}`,
    name: opts.name || 'Custom Script',
    role: opts.role || 'builder',
    model: opts.model || 'script',
    event: opts.event || 'update',
    state: opts.state || 'terminal',
    status: opts.status || 'Ejecutando...',
    toolName: opts.tool,
    thought: opts.thought
  });
}

async function handleWrap(args) {
  const sep = args.indexOf('--');
  if (sep === -1 || sep === args.length - 1) {
    console.error('Uso: ofi wrap [--name Nombre] [--role builder|researcher|coordinator] -- <comando> [args...]');
    process.exit(1);
  }

  const flagArgs = args.slice(0, sep);
  const cmdParts = args.slice(sep + 1);
  const opts = parseFlags(flagArgs);
  const cmd = cmdParts[0];
  const cmdArgs = cmdParts.slice(1);

  const agentId = opts.id || `wrap_${crypto.randomBytes(4).toString('hex')}`;
  const runtime = findRuntimeInfo(process.cwd());

  // Spawn wrapped command as an independent child process without shell interpolation
  const child = spawn(cmd, cmdArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, OFI_AGENT_ID: agentId }
  });

  if (runtime) {
    await postJson(runtime, '/api/events', {
      id: agentId,
      name: opts.name || path.basename(cmd),
      role: opts.role || 'builder',
      model: 'script',
      pid: process.pid,
      event: 'update',
      state: 'terminal',
      status: `${path.basename(cmd)} ${cmdArgs.join(' ')}`.trim()
    });
  }

  let pollTimer = null;
  if (runtime) {
    pollTimer = setInterval(async () => {
      const status = await getJson(runtime, `/api/agent-status/${encodeURIComponent(agentId)}`);
      if (status && status.fired) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }, 1_000);
    pollTimer.unref();
  }

  child.on('exit', async (code) => {
    if (pollTimer) clearInterval(pollTimer);
    if (runtime) {
      await postJson(runtime, '/api/events', {
        id: agentId,
        name: opts.name || path.basename(cmd),
        event: code === 0 ? 'done' : 'error',
        status: code === 0 ? 'Script finalizado' : `Exit code ${code ?? '?'}`
      });
    }
    process.exit(code ?? 0);
  });
}

function handleSetup() {
  const hooksDir = path.join(process.cwd(), '.agents');
  const hooksFile = path.join(hooksDir, 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });

  const binPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'ofi.mjs');
  const relCommand = path.relative(hooksDir, binPath).replace(/\\/g, '/');
  const commandStr = `node ${relCommand.startsWith('.') ? relCommand : './' + relCommand} hook agy`;
  const hooksConfig = {
    ofiagentic: {
      SessionStart: [{ type: 'command', command: commandStr, timeout: 5 }],
      PreInvocation: [{ type: 'command', command: commandStr, timeout: 5 }],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: commandStr, timeout: 20 }]
        }
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: commandStr, timeout: 5 }]
        }
      ],
      Stop: [{ type: 'command', command: commandStr, timeout: 5 }]
    }
  };

  fs.writeFileSync(hooksFile, `${JSON.stringify(hooksConfig, null, 2)}\n`, 'utf8');
  console.log(`✅ Hooks de Antigravity configurados en ${hooksFile}`);
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      out[arg.slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return out;
}

const [, , subcommand, ...rest] = process.argv;

if (subcommand === 'hook') {
  const provider = rest[0] === 'claude' ? 'claude' : 'agy';
  await handleHook(provider);
} else if (subcommand === 'emit') {
  await handleEmit(rest);
} else if (subcommand === 'wrap') {
  await handleWrap(rest);
} else if (subcommand === 'setup') {
  handleSetup();
} else {
  console.log('OfiAgentic CLI\n  ofi hook <agy|claude>\n  ofi wrap [--name N] [--role R] -- <cmd>\n  ofi emit --id ID --name N --state S --status T\n  ofi setup');
}
