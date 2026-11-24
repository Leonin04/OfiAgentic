import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createOfiServer, type OfiServerInstance } from '../src/server/index.js';
import { maskSensitiveText, validateDirectoryBoundary } from '../src/server/security.js';

function createTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ofiagentic-test-'));
}

async function getBrowserSession(baseUrl: string): Promise<{ cookie: string; csrfToken: string }> {
  const res = await fetch(`${baseUrl}/api/session`);
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('ofi_sid='), 'Expected HttpOnly session cookie');
  assert.ok(setCookie.includes('HttpOnly'), 'Cookie must be HttpOnly');
  assert.ok(setCookie.includes('SameSite=Strict'), 'Cookie must be SameSite=Strict');
  const cookie = setCookie.split(';')[0];
  const data = (await res.json()) as { csrfToken: string };
  assert.ok(data.csrfToken.length >= 32);
  return { cookie, csrfToken: data.csrfToken };
}

test('Security utilities: maskSensitiveText and validateDirectoryBoundary', () => {
  const masked = maskSensitiveText(
    'Authorization: Bearer supersecret123456 email alice@example.com key=sk-1234567890abcdef1234'
  );
  assert.ok(!masked.includes('supersecret123456'));
  assert.ok(!masked.includes('alice@example.com'));
  assert.ok(!masked.includes('sk-1234567890abcdef1234'));
  assert.ok(masked.includes('a***@example.com'));

  const root = createTempWorkspace();
  try {
    const inside = path.join(root, 'sub');
    fs.mkdirSync(inside);
    assert.ok(validateDirectoryBoundary(inside, root));
    assert.equal(validateDirectoryBoundary(path.join(root, '..', '..', 'etc', 'passwd'), root), null);
    assert.equal(validateDirectoryBoundary(`${root}-evil`, root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP & WebSocket security controls (loopback, CSRF, Origin, Methods, CSP)', async () => {
  const workspace = createTempWorkspace();
  const server: OfiServerInstance = await createOfiServer({
    port: 0,
    workspaceRoot: workspace,
    writeHomeRuntime: false
  });

  try {
    const addr = server.httpServer.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // Security headers check
    const headRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(headRes.status, 200);
    const csp = headRes.headers.get('content-security-policy') || '';
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(!csp.includes('unsafe-inline'));
    assert.ok(!csp.includes('unsafe-eval'));
    assert.equal(headRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(headRes.headers.get('x-content-type-options'), 'nosniff');

    // Disallowed methods
    const delRes = await fetch(`${baseUrl}/api/state`, { method: 'DELETE' });
    assert.equal(delRes.status, 405);
    const putRes = await fetch(`${baseUrl}/api/state`, { method: 'PUT' });
    assert.equal(putRes.status, 405);

    // Missing CSRF / session -> 403
    const unauthPost = await fetch(`${baseUrl}/api/demo/toggle`, {
      method: 'POST',
      headers: { Origin: baseUrl }
    });
    assert.equal(unauthPost.status, 403);

    const { cookie, csrfToken } = await getBrowserSession(baseUrl);

    // Untrusted Origin -> 403
    const badOriginRes = await fetch(`${baseUrl}/api/demo/toggle`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken
      }
    });
    assert.equal(badOriginRes.status, 403);

    // Wrong CSRF -> 403
    const badCsrfRes = await fetch(`${baseUrl}/api/demo/toggle`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Cookie: cookie,
        'X-CSRF-Token': 'wrong-token'
      }
    });
    assert.equal(badCsrfRes.status, 403);

    // Valid authenticated POST -> 200
    const okRes = await fetch(`${baseUrl}/api/demo/toggle`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Cookie: cookie,
        'X-CSRF-Token': csrfToken
      }
    });
    assert.equal(okRes.status, 200);

    // WebSocket rejects untrusted Origin
    await new Promise<void>((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { Origin: 'https://evil.example', Cookie: cookie }
      });
      badWs.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 403);
        resolve();
      });
      badWs.on('error', () => resolve());
    });

    // WebSocket succeeds with trusted Origin + session cookie + CSRF auth frame
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { Origin: baseUrl, Cookie: cookie }
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', csrfToken }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as { type: string };
        if (msg.type === 'auth_ok') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Independent agent firing kills ONLY the target worker (no chain death)', async () => {
  const workspace = createTempWorkspace();
  const server = await createOfiServer({
    port: 0,
    workspaceRoot: workspace,
    writeHomeRuntime: false,
    leavingTimeoutMs: 400
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const binScript = path.resolve(process.cwd(), 'bin/ofi.mjs');

  const proc1 = spawn(
    process.execPath,
    [binScript, 'wrap', '--id', 'wrap_alpha', '--name', 'Alpha', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'],
    { cwd: workspace, stdio: 'ignore', shell: false }
  );
  const proc2 = spawn(
    process.execPath,
    [binScript, 'wrap', '--id', 'wrap_beta', '--name', 'Beta', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'],
    { cwd: workspace, stdio: 'ignore', shell: false }
  );

  try {
    // Wait until both wrapped agents register
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      const st = (await (await fetch(`${baseUrl}/api/state`)).json()) as {
        agents: Array<{ id: string }>;
      };
      if (st.agents.some((a) => a.id === 'wrap_alpha') && st.agents.some((a) => a.id === 'wrap_beta')) {
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    assert.ok(server.state.findAgent('wrap_alpha'), 'Alpha must be registered');
    assert.ok(server.state.findAgent('wrap_beta'), 'Beta must be registered');

    const { cookie, csrfToken } = await getBrowserSession(baseUrl);
    const fireRes = await fetch(`${baseUrl}/api/agents/wrap_alpha/fire`, {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Cookie: cookie,
        'X-CSRF-Token': csrfToken
      }
    });
    assert.equal(fireRes.status, 200);

    // Wait for proc1 to exit due to firing
    const exitCode1 = await new Promise<number | null>((resolve) => {
      if (proc1.exitCode !== null) return resolve(proc1.exitCode);
      proc1.once('exit', (code) => resolve(code));
      setTimeout(() => resolve(proc1.exitCode), 4_000);
    });
    assert.notEqual(exitCode1, undefined);

    // Give a brief window and verify Beta is still completely alive and running
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(proc2.exitCode, null, 'Second independent worker must NOT die when first is fired');
    const betaSnap = server.state.findAgent('wrap_beta');
    assert.ok(betaSnap && betaSnap.state !== 'fired', 'Beta state must remain active');
  } finally {
    try {
      proc1.kill('SIGKILL');
    } catch {
      // already dead
    }
    try {
      proc2.kill('SIGKILL');
    } catch {
      // already dead
    }
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Hook-connected subagent firing isolates termination and Boss Gate approves/denies cleanly', async () => {
  const workspace = createTempWorkspace();
  const server = await createOfiServer({
    port: 0,
    workspaceRoot: workspace,
    writeHomeRuntime: false,
    bossRequestTimeoutMs: 500
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
    const { cookie, csrfToken } = await getBrowserSession(baseUrl);

    // Connect a WebSocket UI client so Boss Gate waits for Boss response
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: { Origin: baseUrl, Cookie: cookie }
      });
      sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', csrfToken })));
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as { type: string };
        if (msg.type === 'auth_ok') resolve(sock);
      });
      sock.on('error', reject);
    });

    const hookHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.security.hookToken}`
    };

    // Register coordinator + subagent via hooks
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'conv_coord', modelName: 'gemini-4' })
    });
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: 'conv_sub',
        parentConversationId: 'conv_coord',
        modelName: 'gemini-4'
      })
    });

    // Enable Boss Gate and test interactive approval
    await fetch(`${baseUrl}/api/settings/boss-gate`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ enabled: true })
    });

    const pendingToolPromise = fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv_coord',
        toolCall: { id: 'tc_1', name: 'run_command', args: { CommandLine: 'npm test' } }
      })
    });

    await new Promise((r) => setTimeout(r, 80));
    const queue = server.state.getBossQueue();
    assert.equal(queue.length, 1);

    await fetch(`${baseUrl}/api/boss/respond`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ requestId: queue[0].id, decision: 'allow' })
    });

    const toolDecision = (await (await pendingToolPromise).json()) as { decision: string };
    assert.equal(toolDecision.decision, 'allow');

    // Fire ONLY the subagent
    const subAgent = server.state.findAgent('conv_sub');
    assert.ok(subAgent);
    await fetch(`${baseUrl}/api/agents/${subAgent.id}/fire`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken }
    });

    // Subagent gets denied on next PreToolUse; Coordinator continues normally
    const subHookRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv_sub',
          toolCall: { id: 'tc_2', name: 'read_file', args: { Path: 'README.md' } }
        })
      })
    ).json()) as { decision: string };
    assert.equal(subHookRes.decision, 'deny');

    const coordHookRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv_coord',
          toolCall: { id: 'tc_3', name: 'read_file', args: { Path: 'README.md' } }
        })
      })
    ).json()) as Record<string, unknown>;
    assert.equal(coordHookRes.decision, 'ask');

    // Also verify when bossGateEnabled is false, agy PreToolUse returns decision: 'ask'
    await fetch(`${baseUrl}/api/settings/boss-gate`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ enabled: false })
    });
    const nonGatedRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv_coord',
          toolCall: { id: 'tc_4', name: 'read_file', args: { Path: 'README.md' } }
        })
      })
    ).json()) as Record<string, unknown>;
    assert.equal(nonGatedRes.decision, 'ask');

    ws.close();
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('CLI conversation continuity after firing (mid-turn & coffee) + subagent linking + /stop', async () => {
  const workspace = createTempWorkspace();
  const server = await createOfiServer({
    port: 0,
    workspaceRoot: workspace,
    writeHomeRuntime: false,
    leavingTimeoutMs: 250
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const hookHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${server.security.hookToken}`
  };

  try {
    const { cookie, csrfToken } = await getBrowserSession(baseUrl);

    // 1. Start main CLI conversation and enter active turn
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: 'conv_main',
        modelName: 'gemini-4'
      })
    });
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: 'conv_main',
        lastUserInput: 'Prompt 1'
      })
    });

    const mainAgent = server.state.findAgent('conv_main');
    assert.ok(mainAgent);
    assert.equal(mainAgent.isRootSession, true);

    // 2. Fire main CLI agent mid-turn
    const fireRes = await fetch(`${baseUrl}/api/agents/${mainAgent.id}/fire`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken }
    });
    assert.equal(fireRes.status, 200);

    // Immediate PreToolUse in same turn is denied
    const midTurnTool = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv_main',
          lastUserInput: 'Prompt 1',
          toolCall: { id: 'tc_m1', name: 'read_file', args: { Path: 'README.md' } }
        })
      })
    ).json()) as { decision?: string };
    assert.equal(midTurnTool.decision, 'deny');

    // Same-turn PreInvocation terminates once
    const termRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreInvocation',
          conversationId: 'conv_main',
          lastUserInput: 'Prompt 1'
        })
      })
    ).json()) as { terminationBehavior?: string };
    assert.equal(termRes.terminationBehavior, 'terminate');

    // 3. New user turn in the SAME conversationId MUST continue cleanly (never permanently locked)
    const nextTurnRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreInvocation',
          conversationId: 'conv_main',
          lastUserInput: 'Prompt 2'
        })
      })
    ).json()) as { terminationBehavior?: string };
    assert.equal(nextTurnRes.terminationBehavior, undefined);

    const nextToolRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: 'conv_main',
          lastUserInput: 'Prompt 2',
          toolCall: { id: 'tc_m2', name: 'read_file', args: { Path: 'README.md' } }
        })
      })
    ).json()) as { decision?: string };
    assert.equal(nextToolRes.decision, 'ask');

    const revivedMain = server.state.findAgent('conv_main');
    assert.ok(revivedMain && revivedMain.state !== 'fired');

    // 4. Fire while already in coffee (after Stop): next PreInvocation must immediately succeed
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({ hookEventName: 'Stop', conversationId: 'conv_main' })
    });
    assert.equal(server.state.findAgent('conv_main')?.state, 'coffee');

    await fetch(`${baseUrl}/api/agents/${revivedMain.id}/fire`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken }
    });
    const afterCoffeeRes = (await (
      await fetch(`${baseUrl}/api/hooks/agy`, {
        method: 'POST',
        headers: hookHeaders,
        body: JSON.stringify({
          hookEventName: 'PreInvocation',
          conversationId: 'conv_main',
          lastUserInput: 'Prompt 3'
        })
      })
    ).json()) as { terminationBehavior?: string };
    assert.equal(afterCoffeeRes.terminationBehavior, undefined);

    // 5. Subagent linking via invoke_subagent without parentConversationId
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv_main',
        toolCall: {
          id: 'tc_sub',
          name: 'invoke_subagent',
          args: { TypeName: 'research', Role: 'Codebase Researcher' }
        }
      })
    });
    await fetch(`${baseUrl}/api/hooks/agy`, {
      method: 'POST',
      headers: hookHeaders,
      body: JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: 'conv_sub2',
        modelName: 'gemini-4'
      })
    });
    const sub2 = server.state.findAgent('conv_sub2');
    assert.ok(sub2);
    assert.equal(sub2.role, 'researcher');
    assert.equal(sub2.name, 'Codebase Researcher');
    assert.equal(sub2.isRootSession, false);
    assert.equal(sub2.parentId, server.state.findAgent('conv_main')?.id);

    // 6. POST /api/agents/:id/stop aborts turn while keeping agent alive in office
    const currentMain = server.state.findAgent('conv_main');
    assert.ok(currentMain);
    const stopRes = await fetch(`${baseUrl}/api/agents/${currentMain.id}/stop`, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: cookie, 'X-CSRF-Token': csrfToken }
    });
    assert.equal(stopRes.status, 200);
    const afterStop = server.state.findAgent('conv_main');
    assert.ok(afterStop);
    assert.equal(afterStop.state, 'idle');
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Directory picker boundary security & headless skipPermissions CLI args', async () => {
  const workspace = createTempWorkspace();
  const projA = path.join(workspace, 'project-a');
  const projB = path.join(workspace, 'project-b');
  const hiddenDir = path.join(workspace, '.hidden-dir');
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);
  fs.mkdirSync(hiddenDir);

  const server = await createOfiServer({
    port: 0,
    workspaceRoot: workspace,
    allowedAgentRoots: [workspace],
    writeHomeRuntime: false
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  try {
    // Unauthenticated /api/fs/dirs -> 403
    const unauthDir = await fetch(`${baseUrl}/api/fs/dirs`);
    assert.equal(unauthDir.status, 403);

    const { cookie } = await getBrowserSession(baseUrl);

    // Authenticated listing inside workspace -> 200, omits .hidden-dir
    const listRes = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(workspace)}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(listRes.status, 200);
    const listing = (await listRes.json()) as {
      currentPath: string;
      directories: Array<{ name: string; path: string }>;
    };
    assert.deepEqual(
      listing.directories.map((d) => d.name),
      ['project-a', 'project-b']
    );

    // Outside allowed roots & prefix-bypass -> 400
    const etcRes = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent('/etc')}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(etcRes.status, 400);

    const prefixBypassRes = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(`${workspace}-evil`)}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(prefixBypassRes.status, 400);

    // Verify CLI permission, mode, & resume flags
    const skipDefaultArgs = server.spawner.buildArgs('agy', 'default', 'test prompt', undefined, true);
    assert.ok(skipDefaultArgs.includes('--dangerously-skip-permissions'));
    assert.ok(skipDefaultArgs.includes('--output-format'));
    assert.ok(!skipDefaultArgs.includes('--mode'));

    const skipAutoArgs = server.spawner.buildArgs('agy', 'auto', 'test prompt', undefined, true);
    assert.ok(!skipAutoArgs.includes('--mode'));

    const planArgs = server.spawner.buildArgs('agy', 'plan', 'test prompt', undefined, true);
    assert.ok(planArgs.includes('--mode'));
    assert.ok(planArgs.includes('plan'));

    const resumeNoSkipArgs = server.spawner.buildArgs('agy', 'accept-edits', 'test prompt', 'conv_123', false);
    assert.equal(resumeNoSkipArgs[0], '--resume');
    assert.equal(resumeNoSkipArgs[1], 'conv_123');
    assert.ok(resumeNoSkipArgs.includes('--mode'));
    assert.ok(resumeNoSkipArgs.includes('accept-edits'));
    assert.ok(!resumeNoSkipArgs.includes('--dangerously-skip-permissions'));
  } finally {
    await server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
