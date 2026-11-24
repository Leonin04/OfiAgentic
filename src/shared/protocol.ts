export type AgentSource = 'agy' | 'claude' | 'custom' | 'web' | 'demo';

export type AgentRole = 'coordinator' | 'researcher' | 'builder';

export type AgentActivityState =
  | 'spawning'
  | 'idle'
  | 'planning'
  | 'reading'
  | 'coding'
  | 'terminal'
  | 'asking_boss'
  | 'error'
  | 'coffee'
  | 'fired'
  | 'leaving';

export type AgentEngine = 'agy' | 'claude' | 'codex' | 'gemini';

export type AgentExecutionMode = 'default' | 'auto' | 'accept-edits' | 'plan';

export interface ToolLogEntry {
  id: string;
  timestamp: number;
  toolName: string;
  summary: string;
  status: 'running' | 'done' | 'error';
}

export interface BossRequest {
  id: string;
  agentId: string;
  agentName: string;
  kind: 'permission' | 'question';
  title: string;
  commandOrPrompt: string;
  createdAt: number;
  expiresAt: number;
}

export interface AgentSnapshot {
  id: string;
  conversationId?: string;
  name: string;
  source: AgentSource;
  role: AgentRole;
  model: string;
  state: AgentActivityState;
  statusText: string;
  deskIndex: number | null;
  parentId?: string;
  cwd?: string;
  isRootSession?: boolean;
  skipPermissions?: boolean;
  canPrompt: boolean;
  canFire: boolean;
  thoughtPreview: string;
  recentTools: ToolLogEntry[];
  touchedFiles: string[];
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
  coffeeUntil?: number;
  bossRequestId?: string;
}

export interface OfficeMetrics {
  activeAgents: number;
  loungingAgents: number;
  totalToolsRun: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  deskCapacity: number;
  bySource: Record<AgentSource, number>;
  activityHistory: number[];
}

export interface EngineInfo {
  id: AgentEngine;
  label: string;
  available: boolean;
}

export interface SessionInfoResponse {
  csrfToken: string;
  workspaceRoot: string;
  homeDir: string;
  availableEngines: EngineInfo[];
  bossGateEnabled: boolean;
  demoRunning: boolean;
}

export interface DirListingEntry {
  name: string;
  path: string;
}

export interface DirListingResponse {
  currentPath: string;
  parentPath: string | null;
  workspaceRoot: string;
  homeDir: string;
  directories: DirListingEntry[];
}

export interface HireAgentPayload {
  name: string;
  engine: AgentEngine;
  role: AgentRole;
  mode: AgentExecutionMode;
  prompt: string;
  cwd?: string;
  skipPermissions?: boolean;
}

export interface PromptAgentPayload {
  prompt: string;
}

export interface BossRespondPayload {
  requestId: string;
  decision: 'allow' | 'deny';
  note?: string;
}

export type ClientWsMessage =
  | { type: 'auth'; csrfToken: string }
  | { type: 'ping' };

export type ServerWsMessage =
  | { type: 'auth_ok' }
  | {
      type: 'state_sync';
      agents: AgentSnapshot[];
      bossQueue: BossRequest[];
      metrics: OfficeMetrics;
      availableEngines: EngineInfo[];
      bossGateEnabled: boolean;
      demoRunning: boolean;
    }
  | { type: 'agent_updated'; agent: AgentSnapshot }
  | { type: 'agent_removed'; agentId: string }
  | { type: 'boss_queue'; bossQueue: BossRequest[] }
  | { type: 'metrics'; metrics: OfficeMetrics }
  | { type: 'settings_updated'; bossGateEnabled: boolean; demoRunning: boolean };

const READING_TOOLS = new Set([
  'read_file',
  'view_file',
  'search_web',
  'grep_search',
  'find_by_name',
  'list_dir',
  'view_file_outline',
  'view_code_item',
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch'
]);

const CODING_TOOLS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit'
]);

const TERMINAL_TOOLS = new Set([
  'run_command',
  'manage_task',
  'send_command_input',
  'command_status',
  'Bash',
  'KillShell'
]);

const PLANNING_TOOLS = new Set([
  'exit_plan_mode',
  'enter_plan_mode',
  'update_steps',
  'invoke_subagent',
  'send_message',
  'manage_subagents',
  'swarm',
  'run_workflow',
  'Task',
  'TodoWrite'
]);

const BOSS_TOOLS = new Set(['ask_question', 'AskUserQuestion']);

export function classifyToolToActivity(toolName: string): AgentActivityState {
  if (BOSS_TOOLS.has(toolName)) return 'asking_boss';
  if (READING_TOOLS.has(toolName)) return 'reading';
  if (CODING_TOOLS.has(toolName)) return 'coding';
  if (TERMINAL_TOOLS.has(toolName)) return 'terminal';
  if (PLANNING_TOOLS.has(toolName)) return 'planning';
  const lower = toolName.toLowerCase();
  if (lower.includes('read') || lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return 'reading';
  }
  if (lower.includes('edit') || lower.includes('write')) {
    return 'coding';
  }
  if (lower.includes('bash') || lower.includes('command') || lower.includes('exec') || lower.includes('shell')) {
    return 'terminal';
  }
  if (lower.includes('plan') || lower.includes('agent') || lower.includes('swarm')) {
    return 'planning';
  }
  return 'coding';
}
