import path from 'node:path';
import type { AgentRole, AgentSource } from '../shared/protocol.js';
import type { AgyTranscriptWatcher } from './agyWatcher.js';
import { maskSensitiveText, sanitizeLabel } from './security.js';
import type { StateManager } from './stateManager.js';

export class HookBridge {
  constructor(
    private readonly state: StateManager,
    private readonly watcher: AgyTranscriptWatcher
  ) {}

  async handleHook(provider: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source: AgentSource = provider === 'claude' ? 'claude' : 'agy';
    const eventName =
      typeof body.hookEventName === 'string'
        ? body.hookEventName
        : typeof body.hook_event_name === 'string'
          ? body.hook_event_name
          : 'Unknown';

    const conversationId =
      typeof body.conversationId === 'string'
        ? body.conversationId
        : typeof body.session_id === 'string'
          ? body.session_id
          : undefined;

    const explicitAgentId =
      typeof body.ofiAgentId === 'string' && body.ofiAgentId
        ? body.ofiAgentId
        : undefined;

    const lastUserInput = typeof body.lastUserInput === 'string' ? body.lastUserInput : undefined;
    const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
    const targetKey = explicitAgentId || conversationId || `${source}_${Date.now()}`;

    // Abort ONLY the current turn (or permanent fired web worker), never permanently locking CLI conversations
    const hookAbort = this.state.checkAndConsumeHookAbort({
      targetKey,
      conversationId,
      eventName,
      lastUserInput
    });
    if (hookAbort === 'deny_tool') {
      return { decision: 'deny', reason: 'Turno detenido / empleado despedido desde OfiAgentic.' };
    }
    if (hookAbort === 'terminate_invocation') {
      return {
        terminationBehavior: 'terminate',
        injectSteps: [
          {
            errorMessage: {
              userMessage: 'Turno detenido desde OfiAgentic. Escribe otro mensaje cuando quieras continuar.'
            }
          }
        ]
      };
    }

    const transcriptPath = typeof body.transcriptPath === 'string' ? body.transcriptPath : undefined;
    const modelName = typeof body.modelName === 'string' ? body.modelName : undefined;
    const existing = explicitAgentId
      ? this.state.findAgent(explicitAgentId)
      : conversationId
        ? this.state.findAgent(conversationId)
        : undefined;

    let name: string | undefined;
    let role: AgentRole | undefined;
    let parentId: string | undefined;
    let isRootSession: boolean | undefined;

    if (!explicitAgentId && !existing) {
      const explicitSub = Boolean(body.parentConversationId || body.isSubagent);
      const pendingSub = !explicitSub && conversationId ? this.state.consumePendingSubagent(conversationId) : undefined;
      if (pendingSub) {
        name = pendingSub.name;
        role = pendingSub.role;
        parentId = pendingSub.parentAgentId;
        isRootSession = false;
      } else if (explicitSub) {
        name = `Subagente ${targetKey.slice(0, 6)}`;
        role = 'builder';
        parentId =
          typeof body.parentConversationId === 'string'
            ? this.state.findAgent(body.parentConversationId)?.id
            : undefined;
        isRootSession = false;
      } else {
        name = source === 'claude' ? 'Claude (Sesión Principal)' : 'AGY (Sesión Principal)';
        role = 'coordinator';
        isRootSession = true;
      }
    }

    const agent = this.state.upsertAgent({
      id: explicitAgentId,
      conversationId,
      name,
      source: existing?.source ?? source,
      role,
      model: modelName,
      parentId,
      cwd,
      lastUserInput,
      isRootSession
    });

    if (transcriptPath && conversationId) {
      this.watcher.watchTranscript(transcriptPath, conversationId);
    }

    if (eventName === 'SessionStart') {
      this.state.setAgentActivity(agent.id, 'idle', 'Sesión iniciada');
      return {};
    }

    if (eventName === 'PreInvocation' || eventName === 'UserPromptSubmit') {
      const promptHint = lastUserInput ? maskSensitiveText(sanitizeLabel(lastUserInput, 70)) : 'Pensando...';
      this.state.setAgentActivity(agent.id, 'planning', promptHint, {
        thoughtPreview: lastUserInput
      });
      return {};
    }

    if (eventName === 'PostInvocation') {
      return {};
    }

    if (eventName === 'PreToolUse') {
      const toolCall = (body.toolCall && typeof body.toolCall === 'object'
        ? body.toolCall
        : {}) as Record<string, unknown>;
      const toolName =
        typeof toolCall.name === 'string'
          ? toolCall.name
          : typeof body.tool_name === 'string'
            ? body.tool_name
            : 'tool';
      const toolCallId =
        typeof toolCall.id === 'string' ? toolCall.id : `tc_${Date.now()}`;
      const args = (toolCall.args && typeof toolCall.args === 'object'
        ? toolCall.args
        : body.tool_input && typeof body.tool_input === 'object'
          ? body.tool_input
          : {}) as Record<string, unknown>;

      if (toolName === 'invoke_subagent' || toolName === 'Task') {
        const roleRaw =
          typeof args.TypeName === 'string'
            ? args.TypeName
            : typeof args.subagent_type === 'string'
              ? args.subagent_type
              : '';
        const roleLabel =
          typeof args.Role === 'string'
            ? args.Role
            : typeof args.description === 'string'
              ? args.description
              : 'Subagente';
        this.state.registerPendingSubagent({
          parentAgentId: agent.id,
          parentConversationId: conversationId,
          name: sanitizeLabel(roleLabel, 48) || 'Subagente',
          role:
            roleRaw.toLowerCase().includes('research') || roleRaw.toLowerCase().includes('explore')
              ? 'researcher'
              : 'builder'
        });
      }

      const { summary, filePath } = summarizeToolArgs(toolName, args);
      this.state.recordToolStart(agent.id, toolCallId, toolName, summary, filePath);

      const isQuestion = toolName === 'ask_question' || toolName === 'AskUserQuestion';
      const needsBossApproval = this.state.getBossGateEnabled() && shouldGateTool(toolName);

      if (isQuestion || needsBossApproval) {
        const result = await this.state.requestBossApproval({
          agentIdOrConv: agent.id,
          kind: isQuestion ? 'question' : 'permission',
          title: isQuestion ? 'Consulta para El Jefe' : `Permiso: ${toolName}`,
          commandOrPrompt: summary
        });
        if (result.decision === 'deny') {
          return { decision: 'deny', reason: result.note || 'Denegado por El Jefe en OfiAgentic.' };
        }
        if (result.decision === 'allow') {
          return { decision: 'allow' };
        }
        return { decision: 'ask' };
      }

      if (agent.source === 'web' && agent.skipPermissions !== false) {
        return source === 'agy' ? { decision: 'allow' } : {};
      }

      return source === 'agy' ? { decision: 'ask' } : {};
    }

    if (eventName === 'PostToolUse') {
      const toolCall = (body.toolCall && typeof body.toolCall === 'object'
        ? body.toolCall
        : {}) as Record<string, unknown>;
      const toolName =
        typeof toolCall.name === 'string'
          ? toolCall.name
          : typeof body.tool_name === 'string'
            ? body.tool_name
            : 'tool';
      const toolCallId =
        typeof toolCall.id === 'string' ? toolCall.id : `tc_${Date.now()}`;
      const errorStr = typeof body.error === 'string' && body.error ? body.error : undefined;

      this.state.recordToolFinish(agent.id, toolCallId, toolName, Boolean(errorStr), errorStr);
      return {};
    }

    if (eventName === 'Stop') {
      this.state.markCompletedToCoffee(agent.id, 'Tarea finalizada — en cafetería');
      return {};
    }

    return {};
  }

  handleCustomEvent(body: Record<string, unknown>): { fired: boolean; agentId: string } {
    const id = typeof body.id === 'string' ? sanitizeLabel(body.id, 64) : `custom_${Date.now()}`;
    if (this.state.isFired(id)) {
      return { fired: true, agentId: id };
    }

    const name = typeof body.name === 'string' ? sanitizeLabel(body.name, 48) : undefined;
    const roleRaw = typeof body.role === 'string' ? body.role : 'builder';
    const role: AgentRole = roleRaw === 'coordinator' || roleRaw === 'researcher' ? roleRaw : 'builder';
    const model = typeof body.model === 'string' ? sanitizeLabel(body.model, 48) : 'script';
    const hostPid = typeof body.pid === 'number' && Number.isInteger(body.pid) ? body.pid : undefined;

    const agent = this.state.upsertAgent({
      id,
      name,
      source: 'custom',
      role,
      model,
      hostPid,
      canPrompt: false,
      canFire: true
    });

    const eventType = typeof body.event === 'string' ? body.event : 'update';
    const statusText = typeof body.status === 'string' ? body.status : 'Ejecutando script';
    const toolName = typeof body.toolName === 'string' ? body.toolName : undefined;
    const thought = typeof body.thought === 'string' ? body.thought : undefined;

    if (eventType === 'stop' || eventType === 'done') {
      this.state.markCompletedToCoffee(agent.id, statusText || 'Script finalizado');
    } else if (eventType === 'error') {
      this.state.setAgentActivity(agent.id, 'error', statusText);
    } else if (toolName) {
      this.state.recordToolStart(agent.id, `ev_${Date.now()}`, toolName, statusText);
    } else {
      const requestedState = typeof body.state === 'string' ? body.state : 'terminal';
      const allowedStates = new Set([
        'idle',
        'planning',
        'reading',
        'coding',
        'terminal',
        'error',
        'coffee'
      ]);
      const safeState = allowedStates.has(requestedState)
        ? (requestedState as 'idle' | 'planning' | 'reading' | 'coding' | 'terminal' | 'error' | 'coffee')
        : 'terminal';
      this.state.setAgentActivity(agent.id, safeState, statusText, { thoughtPreview: thought });
    }

    return { fired: false, agentId: agent.id };
  }
}

function shouldGateTool(toolName: string): boolean {
  const gated = new Set(['run_command', 'edit_file', 'write_file', 'Bash', 'Edit', 'Write']);
  return gated.has(toolName);
}

function summarizeToolArgs(
  toolName: string,
  args: Record<string, unknown>
): { summary: string; filePath?: string } {
  const filePath =
    (typeof args.Path === 'string' && args.Path) ||
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.path === 'string' && args.path) ||
    undefined;

  if (typeof args.CommandLine === 'string') {
    return { summary: `💻 ${args.CommandLine.slice(0, 72)}` };
  }
  if (typeof args.command === 'string') {
    return { summary: `💻 ${args.command.slice(0, 72)}` };
  }
  if (filePath) {
    return { summary: `${toolName}: ${path.basename(filePath)}`, filePath };
  }
  if (typeof args.query === 'string') {
    return { summary: `🔎 ${args.query.slice(0, 64)}` };
  }
  if (typeof args.Role === 'string') {
    return { summary: `🤝 Subagente: ${args.Role}` };
  }
  return { summary: toolName };
}
