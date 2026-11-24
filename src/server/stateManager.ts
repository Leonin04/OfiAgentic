import crypto from 'node:crypto';
import path from 'node:path';
import type {
  AgentActivityState,
  AgentRole,
  AgentSnapshot,
  AgentSource,
  BossRequest,
  OfficeMetrics,
  ServerWsMessage,
  ToolLogEntry
} from '../shared/protocol.js';
import { classifyToolToActivity } from '../shared/protocol.js';
import { maskSensitiveText, sanitizeLabel } from './security.js';

export interface StateManagerConfig {
  coffeeTimeoutMs?: number;
  leavingTimeoutMs?: number;
  spawningDurationMs?: number;
  bossRequestTimeoutMs?: number;
  hasUiClients?: () => boolean;
  onFireProcess?: (agent: AgentSnapshot & { hostPid?: number; isolatedPid?: number }) => void;
  onStopProcess?: (agent: AgentSnapshot & { hostPid?: number; isolatedPid?: number }) => void;
  onBroadcast?: (message: ServerWsMessage) => void;
}

interface InternalAgent extends AgentSnapshot {
  hostPid?: number;
  isolatedPid?: number;
  lastUserInput?: string;
  coffeeTimer?: NodeJS.Timeout;
  leavingTimer?: NodeJS.Timeout;
  spawnTimer?: NodeJS.Timeout;
}

interface AbortedTurnEntry {
  abortedAt: number;
  lastUserInput?: string;
  preInvocationTerminated: boolean;
}

interface PendingSubagentSpec {
  parentAgentId: string;
  parentConversationId?: string;
  name: string;
  role: AgentRole;
  createdAt: number;
}

interface PendingBossEntry {
  request: BossRequest;
  previousState: AgentActivityState;
  previousStatus: string;
  resolve: (result: { decision: 'allow' | 'deny' | 'ask'; note?: string }) => void;
  timer: NodeJS.Timeout;
}

export interface UpsertAgentInput {
  id?: string;
  conversationId?: string;
  name?: string;
  source: AgentSource;
  role?: AgentRole;
  model?: string;
  parentId?: string;
  cwd?: string;
  lastUserInput?: string;
  skipPermissions?: boolean;
  canPrompt?: boolean;
  canFire?: boolean;
  hostPid?: number;
  isolatedPid?: number;
  isRootSession?: boolean;
}

export class StateManager {
  private readonly agents = new Map<string, InternalAgent>();
  private readonly convToId = new Map<string, string>();
  private readonly firedIds = new Set<string>();
  private readonly abortedTurns = new Map<string, AbortedTurnEntry>();
  private readonly pendingSubagents: PendingSubagentSpec[] = [];
  private readonly bossPending = new Map<string, PendingBossEntry>();
  private readonly deskToAgent = new Map<number, string>();
  private totalToolsRun = 0;
  private activityWindowCount = 0;
  private readonly activityHistory: number[] = new Array(20).fill(0);
  private bossGateEnabled = false;
  private demoRunning = false;

  private readonly coffeeTimeoutMs: number;
  private readonly leavingTimeoutMs: number;
  private readonly spawningDurationMs: number;
  private readonly bossRequestTimeoutMs: number;
  private readonly hasUiClients: () => boolean;
  private readonly onFireProcess?: (agent: AgentSnapshot & { hostPid?: number; isolatedPid?: number }) => void;
  private readonly onStopProcess?: (agent: AgentSnapshot & { hostPid?: number; isolatedPid?: number }) => void;
  private readonly onBroadcast?: (message: ServerWsMessage) => void;
  private readonly metricsInterval: NodeJS.Timeout;

  constructor(config: StateManagerConfig = {}) {
    this.coffeeTimeoutMs = config.coffeeTimeoutMs ?? 180_000;
    this.leavingTimeoutMs = config.leavingTimeoutMs ?? 5_500;
    this.spawningDurationMs = config.spawningDurationMs ?? 2_000;
    this.bossRequestTimeoutMs = config.bossRequestTimeoutMs ?? 15_000;
    this.hasUiClients = config.hasUiClients ?? (() => true);
    this.onFireProcess = config.onFireProcess;
    this.onStopProcess = config.onStopProcess;
    this.onBroadcast = config.onBroadcast;

    this.metricsInterval = setInterval(() => {
      this.activityHistory.push(this.activityWindowCount);
      if (this.activityHistory.length > 20) {
        this.activityHistory.shift();
      }
      this.activityWindowCount = 0;
      this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
    }, 5_000);
    this.metricsInterval.unref();
  }

  dispose(): void {
    clearInterval(this.metricsInterval);
    for (const agent of this.agents.values()) {
      this.clearAgentTimers(agent);
    }
    for (const entry of this.bossPending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: 'ask' });
    }
    this.agents.clear();
    this.convToId.clear();
    this.abortedTurns.clear();
    this.pendingSubagents.length = 0;
    this.bossPending.clear();
    this.deskToAgent.clear();
  }

  isFired(idOrConversationId: string | undefined): boolean {
    if (!idOrConversationId) return false;
    return this.firedIds.has(idOrConversationId);
  }

  clearFiredId(id: string): void {
    this.firedIds.delete(id);
  }

  registerPendingSubagent(spec: {
    parentAgentId: string;
    parentConversationId?: string;
    name: string;
    role: AgentRole;
  }): void {
    const now = Date.now();
    this.prunePendingSubagents(now);
    if (this.pendingSubagents.length >= 16) {
      this.pendingSubagents.shift();
    }
    this.pendingSubagents.push({
      ...spec,
      createdAt: now
    });
  }

  consumePendingSubagent(newConversationId: string): PendingSubagentSpec | undefined {
    const now = Date.now();
    this.prunePendingSubagents(now);
    const idx = this.pendingSubagents.findIndex((entry) => entry.parentConversationId !== newConversationId);
    if (idx === -1) return undefined;
    const [matched] = this.pendingSubagents.splice(idx, 1);
    return matched;
  }

  private prunePendingSubagents(now: number): void {
    for (let i = this.pendingSubagents.length - 1; i >= 0; i -= 1) {
      if (now - this.pendingSubagents[i].createdAt > 45_000) {
        this.pendingSubagents.splice(i, 1);
      }
    }
  }

  checkAndConsumeHookAbort(params: {
    targetKey: string;
    conversationId?: string;
    eventName: string;
    lastUserInput?: string;
  }): 'none' | 'deny_tool' | 'terminate_invocation' {
    if (this.isFired(params.targetKey) || this.isFired(params.conversationId)) {
      if (params.eventName === 'PreToolUse') return 'deny_tool';
      if (params.eventName === 'PreInvocation' || params.eventName === 'PostInvocation') {
        return 'terminate_invocation';
      }
      return 'none';
    }

    const key =
      params.conversationId && this.abortedTurns.has(params.conversationId)
        ? params.conversationId
        : this.abortedTurns.has(params.targetKey)
          ? params.targetKey
          : null;
    if (!key) return 'none';

    const entry = this.abortedTurns.get(key)!;

    if (
      params.eventName === 'Stop' ||
      params.eventName === 'UserPromptSubmit' ||
      params.eventName === 'SessionStart'
    ) {
      this.abortedTurns.delete(key);
      return 'none';
    }

    if (params.eventName === 'PreInvocation') {
      if (
        entry.preInvocationTerminated ||
        (params.lastUserInput && entry.lastUserInput && params.lastUserInput !== entry.lastUserInput)
      ) {
        this.abortedTurns.delete(key);
        return 'none';
      }
      entry.preInvocationTerminated = true;
      return 'terminate_invocation';
    }

    if (params.eventName === 'PostInvocation') {
      entry.preInvocationTerminated = true;
      return 'terminate_invocation';
    }

    if (params.eventName === 'PreToolUse') {
      if (params.lastUserInput && entry.lastUserInput && params.lastUserInput !== entry.lastUserInput) {
        this.abortedTurns.delete(key);
        return 'none';
      }
      return 'deny_tool';
    }

    return 'none';
  }

  getBossGateEnabled(): boolean {
    return this.bossGateEnabled;
  }

  setBossGateEnabled(enabled: boolean): void {
    this.bossGateEnabled = Boolean(enabled);
    this.broadcast({
      type: 'settings_updated',
      bossGateEnabled: this.bossGateEnabled,
      demoRunning: this.demoRunning
    });
  }

  getDemoRunning(): boolean {
    return this.demoRunning;
  }

  setDemoRunning(running: boolean): void {
    this.demoRunning = Boolean(running);
    this.broadcast({
      type: 'settings_updated',
      bossGateEnabled: this.bossGateEnabled,
      demoRunning: this.demoRunning
    });
  }

  findAgent(idOrConversationId: string): AgentSnapshot | undefined {
    const direct = this.agents.get(idOrConversationId);
    if (direct) return this.toSnapshot(direct);
    const mapped = this.convToId.get(idOrConversationId);
    if (mapped) {
      const a = this.agents.get(mapped);
      if (a) return this.toSnapshot(a);
    }
    return undefined;
  }

  getAllAgents(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((a) => this.toSnapshot(a));
  }

  getBossQueue(): BossRequest[] {
    return Array.from(this.bossPending.values()).map((e) => ({ ...e.request }));
  }

  getMetrics(): OfficeMetrics {
    const bySource: Record<AgentSource, number> = {
      agy: 0,
      claude: 0,
      custom: 0,
      web: 0,
      demo: 0
    };
    let activeAgents = 0;
    let loungingAgents = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let maxDesk = 3;

    for (const agent of this.agents.values()) {
      bySource[agent.source] = (bySource[agent.source] ?? 0) + 1;
      totalInputTokens += agent.inputTokens;
      totalOutputTokens += agent.outputTokens;
      if (agent.deskIndex !== null && agent.deskIndex > maxDesk) {
        maxDesk = agent.deskIndex;
      }
      if (agent.state === 'coffee' || agent.state === 'leaving' || agent.state === 'fired') {
        loungingAgents += 1;
      } else {
        activeAgents += 1;
      }
    }

    const deskCapacity = Math.max(4, Math.ceil((maxDesk + 1) / 4) * 4);
    return {
      activeAgents,
      loungingAgents,
      totalToolsRun: this.totalToolsRun,
      totalInputTokens,
      totalOutputTokens,
      deskCapacity,
      bySource,
      activityHistory: [...this.activityHistory]
    };
  }

  upsertAgent(input: UpsertAgentInput): AgentSnapshot {
    const isCliHookSource = input.source === 'agy' || input.source === 'claude';
    if (!isCliHookSource && input.id && this.firedIds.has(input.id)) {
      const existing = this.agents.get(input.id);
      if (existing) return this.toSnapshot(existing);
    }
    if (!isCliHookSource && input.conversationId && this.firedIds.has(input.conversationId)) {
      const mapped = this.convToId.get(input.conversationId);
      const existing = mapped ? this.agents.get(mapped) : undefined;
      if (existing) return this.toSnapshot(existing);
    }

    let agent: InternalAgent | undefined;
    if (input.id) {
      agent = this.agents.get(input.id);
    }
    if (!agent && input.conversationId) {
      const mappedId = this.convToId.get(input.conversationId);
      if (mappedId) agent = this.agents.get(mappedId);
    }

    const now = Date.now();
    if (agent) {
      if (
        agent.state === 'fired' &&
        !this.firedIds.has(agent.id) &&
        !(agent.conversationId && this.firedIds.has(agent.conversationId))
      ) {
        this.clearLeavingTimers(agent);
        agent.state = 'idle';
        agent.canFire = true;
        agent.statusText = 'De vuelta en la oficina';
        if (agent.deskIndex === null) {
          agent.deskIndex = this.allocateDesk(agent.id);
        }
      }
      if (input.conversationId) {
        agent.conversationId = input.conversationId;
        this.convToId.set(input.conversationId, agent.id);
      }
      if (input.name) agent.name = sanitizeLabel(input.name, 48) || agent.name;
      if (input.model) agent.model = sanitizeLabel(input.model, 48) || agent.model;
      if (input.role) agent.role = input.role;
      if (input.cwd) agent.cwd = sanitizeLabel(input.cwd, 260) || agent.cwd;
      if (input.lastUserInput !== undefined) agent.lastUserInput = input.lastUserInput;
      if (typeof input.skipPermissions === 'boolean') agent.skipPermissions = input.skipPermissions;
      if (typeof input.canPrompt === 'boolean') agent.canPrompt = input.canPrompt;
      if (typeof input.canFire === 'boolean') agent.canFire = input.canFire;
      if (typeof input.hostPid === 'number') agent.hostPid = input.hostPid;
      if (typeof input.isolatedPid === 'number') agent.isolatedPid = input.isolatedPid;
      if (typeof input.isRootSession === 'boolean') agent.isRootSession = input.isRootSession;
      agent.updatedAt = now;
      this.broadcastAgent(agent);
      return this.toSnapshot(agent);
    }

    const id = input.id || `agt_${crypto.randomBytes(6).toString('hex')}`;
    const deskIndex = this.allocateDesk(id);
    const defaultName =
      sanitizeLabel(input.name || '', 48) ||
      `${input.role === 'researcher' ? 'Researcher' : input.role === 'coordinator' ? 'Coordinator' : 'Builder'} ${id.slice(-4)}`;

    agent = {
      id,
      conversationId: input.conversationId,
      name: defaultName,
      source: input.source,
      role: input.role ?? 'builder',
      model: sanitizeLabel(input.model || 'auto', 48) || 'auto',
      state: 'spawning',
      statusText: 'Entrando a la oficina...',
      deskIndex,
      parentId: input.parentId,
      cwd: input.cwd ? sanitizeLabel(input.cwd, 260) : undefined,
      skipPermissions: input.skipPermissions,
      canPrompt: input.canPrompt ?? false,
      canFire: input.canFire ?? true,
      thoughtPreview: '',
      recentTools: [],
      touchedFiles: [],
      inputTokens: 0,
      outputTokens: 0,
      createdAt: now,
      updatedAt: now,
      hostPid: input.hostPid,
      isolatedPid: input.isolatedPid,
      isRootSession: input.isRootSession,
      lastUserInput: input.lastUserInput
    };

    this.agents.set(id, agent);
    if (input.conversationId) {
      this.convToId.set(input.conversationId, id);
    }

    agent.spawnTimer = setTimeout(() => {
      const current = this.agents.get(id);
      if (!current || current.state !== 'spawning') return;
      current.state = 'idle';
      current.statusText = 'En su escritorio';
      current.updatedAt = Date.now();
      this.broadcastAgent(current);
    }, this.spawningDurationMs);
    agent.spawnTimer.unref();

    this.broadcastAgent(agent);
    this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
    return this.toSnapshot(agent);
  }

  setAgentActivity(
    idOrConv: string,
    state: AgentActivityState,
    statusText: string,
    options?: { thoughtPreview?: string; model?: string; canPrompt?: boolean }
  ): AgentSnapshot | null {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired') return null;

    if (state !== 'coffee' && state !== 'leaving') {
      this.clearLeavingTimers(agent);
      if (agent.deskIndex === null) {
        agent.deskIndex = this.allocateDesk(agent.id);
      }
      agent.coffeeUntil = undefined;
    }

    agent.state = state;
    agent.statusText = maskSensitiveText(sanitizeLabel(statusText, 96));
    if (options?.thoughtPreview !== undefined) {
      agent.thoughtPreview = maskSensitiveText(options.thoughtPreview).slice(0, 600);
    }
    if (options?.model) {
      agent.model = sanitizeLabel(options.model, 48);
    }
    if (typeof options?.canPrompt === 'boolean') {
      agent.canPrompt = options.canPrompt;
    }
    agent.updatedAt = Date.now();

    this.broadcastAgent(agent);
    return this.toSnapshot(agent);
  }

  recordToolStart(idOrConv: string, toolCallId: string, toolName: string, summaryRaw: string, filePath?: string): AgentSnapshot | null {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired') return null;

    this.clearLeavingTimers(agent);
    if (agent.deskIndex === null) {
      agent.deskIndex = this.allocateDesk(agent.id);
    }
    agent.coffeeUntil = undefined;

    const activity = classifyToolToActivity(toolName);
    const maskedSummary = maskSensitiveText(sanitizeLabel(summaryRaw || toolName, 120));

    agent.state = activity;
    agent.statusText = maskedSummary;
    agent.updatedAt = Date.now();

    const entry: ToolLogEntry = {
      id: toolCallId || `tool_${Date.now()}`,
      timestamp: Date.now(),
      toolName: sanitizeLabel(toolName, 40),
      summary: maskedSummary,
      status: 'running'
    };

    const existingIdx = agent.recentTools.findIndex((t) => t.id === entry.id);
    if (existingIdx >= 0) {
      agent.recentTools[existingIdx] = entry;
    } else {
      agent.recentTools.unshift(entry);
      if (agent.recentTools.length > 25) {
        agent.recentTools.pop();
      }
      this.totalToolsRun += 1;
      this.activityWindowCount += 1;
    }

    if (filePath) {
      const base = sanitizeLabel(path.basename(filePath), 64);
      if (base && !agent.touchedFiles.includes(base)) {
        agent.touchedFiles.unshift(base);
        if (agent.touchedFiles.length > 16) {
          agent.touchedFiles.pop();
        }
      }
    }

    this.broadcastAgent(agent);
    this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
    return this.toSnapshot(agent);
  }

  recordToolFinish(idOrConv: string, toolCallId: string, toolName: string, failed: boolean, errorText?: string): AgentSnapshot | null {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired') return null;

    const match = agent.recentTools.find((t) => t.id === toolCallId) || agent.recentTools.find((t) => t.toolName === toolName && t.status === 'running');
    if (match) {
      match.status = failed ? 'error' : 'done';
    }

    if (failed) {
      agent.state = 'error';
      agent.statusText = maskSensitiveText(sanitizeLabel(errorText || `Error en ${toolName}`, 96));
    } else if (agent.state !== 'asking_boss') {
      agent.state = 'idle';
      agent.statusText = `Completado: ${sanitizeLabel(toolName, 40)}`;
    }
    agent.updatedAt = Date.now();

    this.broadcastAgent(agent);
    return this.toSnapshot(agent);
  }

  updateUsageAndThought(idOrConv: string, delta: { thought?: string; inputTokens?: number; outputTokens?: number; model?: string }): void {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired') return;

    if (delta.thought) {
      agent.thoughtPreview = maskSensitiveText(delta.thought).slice(-600);
    }
    if (typeof delta.inputTokens === 'number' && delta.inputTokens > 0) {
      agent.inputTokens = Math.max(agent.inputTokens, delta.inputTokens);
    }
    if (typeof delta.outputTokens === 'number' && delta.outputTokens > 0) {
      agent.outputTokens = Math.max(agent.outputTokens, delta.outputTokens);
    }
    if (delta.model) {
      agent.model = sanitizeLabel(delta.model, 48);
    }
    agent.updatedAt = Date.now();
    this.broadcastAgent(agent);
  }

  markCompletedToCoffee(idOrConv: string, summaryText = 'En la cafetería'): AgentSnapshot | null {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired' || agent.state === 'leaving') return null;

    this.clearAgentTimers(agent);
    const cooldownMs = agent.isRootSession ? Math.max(this.coffeeTimeoutMs, 15 * 60_000) : this.coffeeTimeoutMs;
    agent.state = 'coffee';
    agent.statusText = sanitizeLabel(summaryText, 96);
    agent.coffeeUntil = Date.now() + cooldownMs;
    agent.updatedAt = Date.now();

    agent.coffeeTimer = setTimeout(() => {
      this.transitionToLeaving(agent.id);
    }, cooldownMs);
    agent.coffeeTimer.unref();

    this.broadcastAgent(agent);
    this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
    return this.toSnapshot(agent);
  }

  requestBossApproval(params: {
    agentIdOrConv: string;
    kind: 'permission' | 'question';
    title: string;
    commandOrPrompt: string;
  }): Promise<{ decision: 'allow' | 'deny' | 'ask'; note?: string }> {
    const agent = this.resolveInternal(params.agentIdOrConv);
    if (!agent) {
      return Promise.resolve({ decision: 'ask' });
    }
    if (
      this.firedIds.has(agent.id) ||
      this.abortedTurns.has(agent.id) ||
      (agent.conversationId && (this.firedIds.has(agent.conversationId) || this.abortedTurns.has(agent.conversationId)))
    ) {
      return Promise.resolve({ decision: 'deny', note: 'Empleado despedido desde OfiAgentic.' });
    }
    if (!this.hasUiClients()) {
      return Promise.resolve({ decision: 'ask' });
    }

    const requestId = `boss_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const request: BossRequest = {
      id: requestId,
      agentId: agent.id,
      agentName: agent.name,
      kind: params.kind,
      title: maskSensitiveText(sanitizeLabel(params.title, 80)),
      commandOrPrompt: maskSensitiveText(params.commandOrPrompt).slice(0, 400),
      createdAt: now,
      expiresAt: now + this.bossRequestTimeoutMs
    };

    const previousState = agent.state;
    const previousStatus = agent.statusText;
    agent.state = 'asking_boss';
    agent.bossRequestId = requestId;
    agent.statusText = 'Esperando firma de El Jefe...';
    agent.updatedAt = now;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.bossPending.get(requestId);
        if (!pending) return;
        this.bossPending.delete(requestId);
        const current = this.agents.get(agent.id);
        if (current && current.state === 'asking_boss') {
          current.bossRequestId = undefined;
          current.state = previousState === 'asking_boss' ? 'idle' : previousState;
          current.statusText = 'Confirmación en terminal';
          current.updatedAt = Date.now();
          this.broadcastAgent(current);
        }
        this.broadcast({ type: 'boss_queue', bossQueue: this.getBossQueue() });
        resolve({ decision: 'ask' });
      }, this.bossRequestTimeoutMs);
      timer.unref();

      this.bossPending.set(requestId, {
        request,
        previousState,
        previousStatus,
        resolve,
        timer
      });

      this.broadcastAgent(agent);
      this.broadcast({ type: 'boss_queue', bossQueue: this.getBossQueue() });
    });
  }

  respondToBossRequest(requestId: string, decision: 'allow' | 'deny', note?: string): boolean {
    const pending = this.bossPending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.bossPending.delete(requestId);

    const agent = this.agents.get(pending.request.agentId);
    if (agent && agent.state !== 'fired') {
      agent.bossRequestId = undefined;
      agent.state = decision === 'allow' ? (pending.previousState === 'asking_boss' ? 'coding' : pending.previousState) : 'error';
      agent.statusText = decision === 'allow' ? 'Aprobado por El Jefe' : 'Denegado por El Jefe';
      agent.updatedAt = Date.now();
      this.broadcastAgent(agent);
    }

    this.broadcast({ type: 'boss_queue', bossQueue: this.getBossQueue() });
    pending.resolve({ decision, note });
    return true;
  }

  stopAgentTurn(idOrConv: string): { ok: boolean; agentId?: string; reason?: string } {
    const agent = this.resolveInternal(idOrConv);
    if (!agent || agent.state === 'fired') {
      return { ok: false, reason: 'Empleado no encontrado' };
    }

    for (const [reqId, pending] of this.bossPending.entries()) {
      if (pending.request.agentId === agent.id) {
        clearTimeout(pending.timer);
        this.bossPending.delete(reqId);
        pending.resolve({ decision: 'deny', note: 'Turno detenido desde OfiAgentic.' });
      }
    }
    this.broadcast({ type: 'boss_queue', bossQueue: this.getBossQueue() });

    this.clearLeavingTimers(agent);
    if (agent.deskIndex === null) {
      agent.deskIndex = this.allocateDesk(agent.id);
    }
    agent.coffeeUntil = undefined;

    if (agent.conversationId && (agent.source === 'agy' || agent.source === 'claude')) {
      this.abortedTurns.set(agent.conversationId, {
        abortedAt: Date.now(),
        lastUserInput: agent.lastUserInput,
        preInvocationTerminated: false
      });
    }

    if (this.onStopProcess) {
      try {
        this.onStopProcess({
          ...this.toSnapshot(agent),
          hostPid: agent.hostPid,
          isolatedPid: agent.isolatedPid
        });
      } catch (err) {
        console.error('[stateManager] Error invoking process stop handler:', err);
      }
    }

    agent.state = 'idle';
    agent.bossRequestId = undefined;
    agent.statusText = '⏹ Turno detenido — listo para seguir';
    agent.updatedAt = Date.now();

    this.broadcastAgent(agent);
    this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
    return { ok: true, agentId: agent.id };
  }

  fireAgent(idOrConv: string): { ok: boolean; agentId?: string; reason?: string } {
    const agent = this.resolveInternal(idOrConv);
    if (!agent) {
      return { ok: false, reason: 'Empleado no encontrado' };
    }

    const isInteractiveCliConv =
      Boolean(agent.conversationId) && (agent.source === 'agy' || agent.source === 'claude');

    if (!isInteractiveCliConv) {
      this.firedIds.add(agent.id);
      if (agent.conversationId) {
        this.firedIds.add(agent.conversationId);
      }
    } else if (agent.conversationId) {
      const mayHaveActiveTurn =
        agent.state !== 'coffee' && agent.state !== 'leaving' && agent.state !== 'fired';
      if (mayHaveActiveTurn) {
        this.abortedTurns.set(agent.conversationId, {
          abortedAt: Date.now(),
          lastUserInput: agent.lastUserInput,
          preInvocationTerminated: false
        });
      }
    }

    // Deny any pending Boss requests owned ONLY by this agent
    for (const [reqId, pending] of this.bossPending.entries()) {
      if (pending.request.agentId === agent.id) {
        clearTimeout(pending.timer);
        this.bossPending.delete(reqId);
        pending.resolve({ decision: 'deny', note: 'Empleado despedido desde OfiAgentic.' });
      }
    }
    this.broadcast({ type: 'boss_queue', bossQueue: this.getBossQueue() });

    this.clearAgentTimers(agent);
    this.releaseDesk(agent);

    agent.state = 'fired';
    agent.canPrompt = false;
    agent.canFire = false;
    agent.bossRequestId = undefined;
    agent.statusText = '📦 ¡Despedido!';
    agent.updatedAt = Date.now();

    // Kill ONLY this agent's isolated process/group if applicable
    if (this.onFireProcess) {
      try {
        this.onFireProcess({
          ...this.toSnapshot(agent),
          hostPid: agent.hostPid,
          isolatedPid: agent.isolatedPid
        });
      } catch (err) {
        console.error('[stateManager] Error invoking process fire handler:', err);
      }
    }

    this.broadcastAgent(agent);

    agent.leavingTimer = setTimeout(() => {
      this.removeAgent(agent.id);
    }, this.leavingTimeoutMs);
    agent.leavingTimer.unref();

    return { ok: true, agentId: agent.id };
  }

  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.clearAgentTimers(agent);
    this.releaseDesk(agent);
    this.agents.delete(agentId);
    if (agent.conversationId) {
      this.convToId.delete(agent.conversationId);
    }
    this.broadcast({ type: 'agent_removed', agentId });
    this.broadcast({ type: 'metrics', metrics: this.getMetrics() });
  }

  private transitionToLeaving(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.state === 'fired') return;
    this.releaseDesk(agent);
    agent.state = 'leaving';
    agent.statusText = 'Saliendo por el ascensor...';
    agent.updatedAt = Date.now();
    this.broadcastAgent(agent);

    agent.leavingTimer = setTimeout(() => {
      this.removeAgent(agentId);
    }, this.leavingTimeoutMs);
    agent.leavingTimer.unref();
  }

  private resolveInternal(idOrConv: string): InternalAgent | undefined {
    const direct = this.agents.get(idOrConv);
    if (direct) return direct;
    const mapped = this.convToId.get(idOrConv);
    if (mapped) return this.agents.get(mapped);
    return undefined;
  }

  private allocateDesk(agentId: string): number {
    for (const [idx, owner] of this.deskToAgent.entries()) {
      if (owner === agentId) return idx;
    }
    let idx = 0;
    while (this.deskToAgent.has(idx)) {
      idx += 1;
    }
    this.deskToAgent.set(idx, agentId);
    return idx;
  }

  private releaseDesk(agent: InternalAgent): void {
    if (agent.deskIndex !== null) {
      if (this.deskToAgent.get(agent.deskIndex) === agent.id) {
        this.deskToAgent.delete(agent.deskIndex);
      }
      agent.deskIndex = null;
    }
  }

  private clearLeavingTimers(agent: InternalAgent): void {
    if (agent.coffeeTimer) {
      clearTimeout(agent.coffeeTimer);
      agent.coffeeTimer = undefined;
    }
    if (agent.leavingTimer) {
      clearTimeout(agent.leavingTimer);
      agent.leavingTimer = undefined;
    }
  }

  private clearAgentTimers(agent: InternalAgent): void {
    this.clearLeavingTimers(agent);
    if (agent.spawnTimer) {
      clearTimeout(agent.spawnTimer);
      agent.spawnTimer = undefined;
    }
  }

  private broadcastAgent(agent: InternalAgent): void {
    this.broadcast({ type: 'agent_updated', agent: this.toSnapshot(agent) });
  }

  private broadcast(message: ServerWsMessage): void {
    if (this.onBroadcast) {
      this.onBroadcast(message);
    }
  }

  private toSnapshot(agent: InternalAgent): AgentSnapshot {
    return {
      id: agent.id,
      conversationId: agent.conversationId,
      name: agent.name,
      source: agent.source,
      role: agent.role,
      model: agent.model,
      state: agent.state,
      statusText: agent.statusText,
      deskIndex: agent.deskIndex,
      parentId: agent.parentId,
      cwd: agent.cwd,
      isRootSession: agent.isRootSession,
      skipPermissions: agent.skipPermissions,
      canPrompt: agent.canPrompt,
      canFire: agent.canFire,
      thoughtPreview: agent.thoughtPreview,
      recentTools: agent.recentTools.map((t) => ({ ...t })),
      touchedFiles: [...agent.touchedFiles],
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      coffeeUntil: agent.coffeeUntil,
      bossRequestId: agent.bossRequestId
    };
  }
}
