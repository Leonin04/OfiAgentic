import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import type {
  AgentEngine,
  AgentExecutionMode,
  AgentRole,
  AgentSnapshot
} from '../shared/protocol.js';
import {
  ALLOWED_ENGINES,
  maskSensitiveText,
  resolveAllowedBinary,
  sanitizeLabel,
  validateAllowedAgentDir
} from './security.js';
import type { StateManager } from './stateManager.js';

interface ManagedProcess {
  agentId: string;
  engine: AgentEngine;
  mode: AgentExecutionMode;
  cwd: string;
  skipPermissions: boolean;
  wasStopped: boolean;
  lastStderrLine: string;
  child: ChildProcess | null;
  pid: number | null;
  stdoutBuffer: string;
  conversationId?: string;
}

export class AgentSpawner {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly allowedRoots: readonly string[];

  constructor(
    private readonly state: StateManager,
    private readonly workspaceRoot: string,
    private readonly runtimeFilePath: string,
    allowedRoots?: readonly string[]
  ) {
    this.allowedRoots = allowedRoots && allowedRoots.length > 0 ? allowedRoots : [workspaceRoot];
  }

  dispose(): void {
    for (const agentId of this.processes.keys()) {
      this.killAgent(agentId);
    }
    this.processes.clear();
  }

  hireAgent(params: {
    name: string;
    engine: AgentEngine;
    role: AgentRole;
    mode: AgentExecutionMode;
    prompt: string;
    cwd?: string;
    skipPermissions?: boolean;
  }): { ok: true; agent: AgentSnapshot } | { ok: false; status: number; error: string } {
    if (!ALLOWED_ENGINES.includes(params.engine)) {
      return { ok: false, status: 400, error: 'Motor de agente no permitido.' };
    }

    const binPath = resolveAllowedBinary(params.engine);
    if (!binPath) {
      return { ok: false, status: 400, error: `El binario "${params.engine}" no está disponible en rutas seguras.` };
    }

    const targetDir = params.cwd
      ? validateAllowedAgentDir(params.cwd, this.allowedRoots)
      : this.workspaceRoot;
    if (!targetDir) {
      return { ok: false, status: 400, error: 'La carpeta raíz seleccionada no existe o está fuera de las rutas permitidas.' };
    }

    const cleanPrompt = params.prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 8000) {
      return { ok: false, status: 400, error: 'El prompt debe tener entre 1 y 8000 caracteres.' };
    }

    const skipPermissions = params.skipPermissions ?? true;
    const agentId = `web_${crypto.randomBytes(6).toString('hex')}`;
    const safeName = sanitizeLabel(params.name, 48) || `${params.engine.toUpperCase()} Worker`;

    const snapshot = this.state.upsertAgent({
      id: agentId,
      name: safeName,
      source: 'web',
      role: params.role,
      model: params.engine,
      cwd: targetDir,
      skipPermissions,
      canPrompt: true,
      canFire: true,
      isRootSession: false
    });

    const managed: ManagedProcess = {
      agentId,
      engine: params.engine,
      mode: params.mode,
      cwd: targetDir,
      skipPermissions,
      wasStopped: false,
      lastStderrLine: '',
      child: null,
      pid: null,
      stdoutBuffer: ''
    };
    this.processes.set(agentId, managed);

    this.spawnTurn(managed, binPath, cleanPrompt);
    return { ok: true, agent: snapshot };
  }

  sendPrompt(agentId: string, prompt: string): { ok: true } | { ok: false; status: number; error: string } {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 8000) {
      return { ok: false, status: 400, error: 'Prompt inválido.' };
    }

    const managed = this.processes.get(agentId);
    if (!managed) {
      return { ok: false, status: 404, error: 'Este agente no es un subproceso gestionado por OfiAgentic.' };
    }
    if (this.state.isFired(agentId)) {
      return { ok: false, status: 409, error: 'Este empleado ya fue despedido.' };
    }
    if (managed.child && managed.child.exitCode === null) {
      return { ok: false, status: 409, error: 'El agente aún está ejecutando el turno actual.' };
    }

    const binPath = resolveAllowedBinary(managed.engine);
    if (!binPath) {
      return { ok: false, status: 400, error: 'Binario no disponible.' };
    }

    this.spawnTurn(managed, binPath, cleanPrompt, managed.conversationId);
    return { ok: true };
  }

  /**
   * Stops only the currently running turn process while keeping the agent and conversationId alive.
   */
  stopTurn(agentId: string): boolean {
    const managed = this.processes.get(agentId);
    if (!managed) return false;
    const targetPid = managed.pid;
    managed.wasStopped = true;
    managed.child = null;
    managed.pid = null;

    if (typeof targetPid === 'number' && targetPid > 1 && targetPid !== process.pid) {
      this.terminateProcessGroup(targetPid);
    }
    return true;
  }

  /**
   * Terminates ONLY this agent's detached process group (never cascades to other agents).
   */
  killAgent(agentId: string, externalHostPid?: number): void {
    const managed = this.processes.get(agentId);
    const targetPid = managed?.pid ?? externalHostPid ?? null;

    if (managed) {
      managed.child = null;
      managed.pid = null;
      this.processes.delete(agentId);
    }

    if (typeof targetPid === 'number' && targetPid > 1 && targetPid !== process.pid) {
      this.terminateProcessGroup(targetPid);
    }
  }

  private terminateProcessGroup(pid: number): void {
    // Send SIGTERM to the isolated process group (-pid), falling back to pid
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return;
      }
    }

    const forceTimer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already terminated
        }
      }
    }, 2_000);
    forceTimer.unref();
  }

  private spawnTurn(managed: ManagedProcess, binPath: string, prompt: string, resumeConversationId?: string): void {
    managed.wasStopped = false;
    managed.lastStderrLine = '';
    managed.stdoutBuffer = '';
    const args = this.buildArgs(managed.engine, managed.mode, prompt, resumeConversationId, managed.skipPermissions);

    const safeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OFI_AGENT_ID: managed.agentId,
      OFI_RUNTIME_FILE: this.runtimeFilePath
    };

    try {
      const child = spawn(binPath, args, {
        cwd: managed.cwd,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeEnv
      });

      managed.child = child;
      managed.pid = child.pid ?? null;

      if (managed.pid) {
        this.state.upsertAgent({
          id: managed.agentId,
          source: 'web',
          isolatedPid: managed.pid,
          canPrompt: true,
          canFire: true
        });
      }

      this.state.setAgentActivity(managed.agentId, 'planning', 'Iniciando turno...', {
        canPrompt: true
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.handleStdoutChunk(managed, chunk.toString('utf8'));
        } catch (err) {
          console.error('[spawner] stdout parse error:', err);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        try {
          const text = maskSensitiveText(chunk.toString('utf8').trim());
          if (text) {
            const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
            const nonWarningLines = lines.filter((l) => !/^warning:/i.test(l));
            if (nonWarningLines.length > 0) {
              managed.lastStderrLine = nonWarningLines[nonWarningLines.length - 1];
              this.state.updateUsageAndThought(managed.agentId, {
                thought: nonWarningLines.join('\n')
              });
            } else if (!managed.lastStderrLine && lines.length > 0) {
              managed.lastStderrLine = lines[lines.length - 1];
            }
          }
        } catch {
          // ignore
        }
      });

      child.on('error', (err) => {
        if (managed.child === child) {
          managed.child = null;
          managed.pid = null;
        }
        if (!this.state.isFired(managed.agentId) && !managed.wasStopped) {
          this.state.setAgentActivity(managed.agentId, 'error', `Error al ejecutar: ${err.message}`);
        }
      });

      child.on('exit', (code, signal) => {
        if (managed.stdoutBuffer.trim()) {
          this.handleStdoutChunk(managed, '\n');
        }
        if (managed.child === child) {
          managed.child = null;
          managed.pid = null;
        }
        if (this.state.isFired(managed.agentId) || managed.wasStopped) {
          return;
        }
        if (code === 0) {
          this.state.markCompletedToCoffee(managed.agentId, 'Turno completado — en cafetería');
        } else {
          const errDetail = managed.lastStderrLine
            ? sanitizeLabel(managed.lastStderrLine, 90)
            : signal || `código ${code ?? '?'}`;
          this.state.setAgentActivity(managed.agentId, 'error', `Error: ${errDetail}`);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'spawn failed';
      this.state.setAgentActivity(managed.agentId, 'error', msg);
    }
  }

  buildArgs(
    engine: AgentEngine,
    mode: AgentExecutionMode,
    prompt: string,
    resumeConversationId?: string,
    skipPermissions = true
  ): string[] {
    if (engine === 'agy') {
      const args = ['-p', prompt, '--output-format', 'stream-json'];
      if (mode === 'accept-edits' || mode === 'plan') {
        args.push('--mode', mode);
      }
      if (skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      if (resumeConversationId) {
        args.unshift('--resume', resumeConversationId);
      }
      return args;
    }

    if (engine === 'claude') {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      if (skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      if (resumeConversationId) {
        args.unshift('--resume', resumeConversationId);
      }
      return args;
    }

    if (engine === 'gemini') {
      return skipPermissions ? ['-p', prompt, '--yolo'] : ['-p', prompt];
    }

    if (engine === 'codex') {
      return skipPermissions ? ['exec', '--full-auto', prompt] : ['-p', prompt];
    }

    return ['-p', prompt];
  }

  private handleStdoutChunk(managed: ManagedProcess, chunk: string): void {
    managed.stdoutBuffer += chunk;
    const lines = managed.stdoutBuffer.split('\n');
    managed.stdoutBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (!line.startsWith('{')) {
        this.state.updateUsageAndThought(managed.agentId, { thought: line });
        continue;
      }

      let obj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        obj = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      const convId =
        typeof obj.conversationId === 'string'
          ? obj.conversationId
          : typeof obj.conversation_id === 'string'
            ? obj.conversation_id
            : typeof obj.session_id === 'string'
              ? obj.session_id
              : undefined;
      if (convId && convId !== managed.conversationId) {
        managed.conversationId = convId;
        this.state.upsertAgent({
          id: managed.agentId,
          conversationId: convId,
          source: 'web'
        });
      }

      const msgObj =
        obj.message && typeof obj.message === 'object'
          ? (obj.message as Record<string, unknown>)
          : undefined;

      const model =
        typeof obj.model === 'string'
          ? obj.model
          : typeof obj.modelName === 'string'
            ? obj.modelName
            : msgObj && typeof msgObj.model === 'string'
              ? msgObj.model
              : undefined;

      let textField =
        typeof obj.text === 'string'
          ? obj.text
          : typeof obj.content === 'string'
            ? obj.content
            : typeof obj.result === 'string'
              ? obj.result
              : typeof obj.thinking === 'string'
                ? obj.thinking
                : undefined;

      const nestedToolCalls: Array<Record<string, unknown>> = [];
      if (msgObj && Array.isArray(msgObj.content)) {
        for (const block of msgObj.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if ((b.type === 'thinking' || b.type === 'text') && typeof b.thinking === 'string') {
            textField = b.thinking;
          } else if (b.type === 'text' && typeof b.text === 'string') {
            textField = b.text;
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            nestedToolCalls.push({
              id: b.id,
              name: b.name,
              args: b.input
            });
          }
        }
      }

      const usageObj =
        obj.usage && typeof obj.usage === 'object'
          ? (obj.usage as Record<string, unknown>)
          : msgObj?.usage && typeof msgObj.usage === 'object'
            ? (msgObj.usage as Record<string, unknown>)
            : undefined;
      const inputTokens =
        typeof obj.input_tokens === 'number'
          ? obj.input_tokens
          : typeof obj.inputTokens === 'number'
            ? obj.inputTokens
            : usageObj && typeof usageObj.input_tokens === 'number'
              ? usageObj.input_tokens
              : undefined;
      const outputTokens =
        typeof obj.output_tokens === 'number'
          ? obj.output_tokens
          : typeof obj.outputTokens === 'number'
            ? obj.outputTokens
            : usageObj && typeof usageObj.output_tokens === 'number'
              ? usageObj.output_tokens
              : undefined;

      if (textField || model || inputTokens || outputTokens) {
        this.state.updateUsageAndThought(managed.agentId, {
          thought: textField,
          model,
          inputTokens,
          outputTokens
        });
      }

      if (typeof obj.tool_name === 'string') {
        const fileCandidate =
          obj.args && typeof obj.args === 'object'
            ? ((obj.args as Record<string, unknown>).Path as string | undefined) ||
              ((obj.args as Record<string, unknown>).file_path as string | undefined)
            : undefined;
        this.state.recordToolStart(
          managed.agentId,
          `stream_${Date.now()}`,
          obj.tool_name,
          obj.tool_name,
          fileCandidate ? path.basename(fileCandidate) : undefined
        );
      }

      const singleCall =
        obj.toolCall && typeof obj.toolCall === 'object' ? [obj.toolCall] : [];
      const multiCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      for (const rawCall of [...singleCall, ...multiCalls, ...nestedToolCalls]) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const call = rawCall as Record<string, unknown>;
        const toolName = typeof call.name === 'string' ? call.name : undefined;
        if (!toolName) continue;
        const callId = typeof call.id === 'string' ? call.id : `stream_${Date.now()}`;
        const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : undefined;
        const fileCandidate =
          (args?.Path as string | undefined) ||
          (args?.file_path as string | undefined) ||
          (args?.path as string | undefined);
        this.state.recordToolStart(
          managed.agentId,
          callId,
          toolName,
          fileCandidate ? `${toolName}: ${path.basename(fileCandidate)}` : toolName,
          fileCandidate ? path.basename(fileCandidate) : undefined
        );
      }
    }
  }
}
