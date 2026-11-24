#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function findFreePort(startPort, maxTries = 20) {
  for (let offset = 0; offset < maxTries; offset += 1) {
    const candidate = startPort + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No free port found starting at ${startPort}`);
}

const requestedPort = Number(process.env.OFI_PORT || 4317);
const port = await findFreePort(requestedPort);

const tsxBin = path.join(rootDir, 'node_modules', '.bin', 'tsx');

const serverProc = spawn(tsxBin, ['watch', 'src/server/index.ts', '--dev'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    OFI_PORT: String(port)
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    serverProc.kill(signal);
  } catch {
    // ignore
  }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

serverProc.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev] Server exited with code ${code}`);
    process.exit(code ?? 1);
  }
});

console.log('\n🏢 OfiAgentic dev mode starting (WSL2 unified server)...');
console.log(`   ➜ Abre en tu navegador: http://localhost:${port}`);
console.log(`   ➜ Alternativa loopback:  http://127.0.0.1:${port}\n`);
