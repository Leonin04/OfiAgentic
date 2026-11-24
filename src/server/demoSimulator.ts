import type { AgentRole, AgentSource } from '../shared/protocol.js';
import type { StateManager } from './stateManager.js';

interface DemoActorSpec {
  id: string;
  name: string;
  source: AgentSource;
  role: AgentRole;
  model: string;
  thoughts: string[];
  tools: Array<{ toolName: string; summary: string; file?: string }>;
}

const DEMO_ACTORS: DemoActorSpec[] = [
  {
    id: 'demo_sofia',
    name: 'Sofía (Coord)',
    source: 'demo',
    role: 'coordinator',
    model: 'gemini-4-carbon',
    thoughts: [
      'Coordinando el sprint entre Researcher y Builders...',
      'Revisando dependencias del módulo WebSocket y seguridad CSRF.',
      'Asignando subtarea de renderizado voxel a Mateo.'
    ],
    tools: [
      { toolName: 'update_steps', summary: '📋 Actualizando checklist del sprint' },
      { toolName: 'invoke_subagent', summary: '🤝 Delegando investigación a Leo' },
      { toolName: 'read_file', summary: '📖 Leyendo protocol.ts', file: 'protocol.ts' }
    ]
  },
  {
    id: 'demo_leo',
    name: 'Leo (Research)',
    source: 'demo',
    role: 'researcher',
    model: 'gemini-4-flash',
    thoughts: [
      'Analizando estructura de hooks.json y rutas de transcript...',
      'Buscando optimizaciones para InstancedMesh en Three.js.'
    ],
    tools: [
      { toolName: 'read_file', summary: '📖 hooks.md', file: 'hooks.md' },
      { toolName: 'search_web', summary: '🔎 Three.js OrthographicCamera damping' },
      { toolName: 'grep_search', summary: '🔎 Buscando BossRequest en src/' }
    ]
  },
  {
    id: 'demo_mateo',
    name: 'Mateo (Builder)',
    source: 'demo',
    role: 'builder',
    model: 'gemini-4-carbon',
    thoughts: [
      'Construyendo avatares voxel articulados y animaciones de café...',
      'Ajustando pathfinding A* alrededor de la mesa de juntas.'
    ],
    tools: [
      { toolName: 'edit_file', summary: '✏️ WorkerAvatar.ts', file: 'WorkerAvatar.ts' },
      { toolName: 'run_command', summary: '💻 npm run build' },
      { toolName: 'write_file', summary: '✏️ Pathfinding.ts', file: 'Pathfinding.ts' }
    ]
  },
  {
    id: 'demo_clara',
    name: 'Clara (Claude)',
    source: 'claude',
    role: 'builder',
    model: 'claude-sonnet',
    thoughts: [
      'Verificando aislamiento de procesos al despedir empleados...',
      'Ejecutando batería de pruebas unitarias.'
    ],
    tools: [
      { toolName: 'Edit', summary: '✏️ agentSpawner.ts', file: 'agentSpawner.ts' },
      { toolName: 'Bash', summary: '💻 npm test' },
      { toolName: 'Read', summary: '📖 security.ts', file: 'security.ts' }
    ]
  },
  {
    id: 'demo_script',
    name: 'Auditor CI',
    source: 'custom',
    role: 'builder',
    model: 'script',
    thoughts: [
      'Comprobando cabeceras CSP y cero innerHTML en cliente...',
      'Escaneando puertos abiertos en 127.0.0.1.'
    ],
    tools: [
      { toolName: 'run_command', summary: '💻 node --test tests/server.test.ts' },
      { toolName: 'read_file', summary: '📖 index.html', file: 'index.html' }
    ]
  }
];

export class DemoSimulator {
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private stepCount = 0;

  constructor(private readonly state: StateManager) {}

  isRunning(): boolean {
    return this.running;
  }

  toggle(): boolean {
    if (this.running) {
      this.stop();
    } else {
      this.start();
    }
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stepCount = 0;
    this.state.setDemoRunning(true);

    for (const spec of DEMO_ACTORS) {
      if (this.state.isFired(spec.id)) continue;
      this.state.upsertAgent({
        id: spec.id,
        name: spec.name,
        source: spec.source,
        role: spec.role,
        model: spec.model,
        canPrompt: false,
        canFire: true
      });
    }

    this.tickTimer = setInterval(() => this.tick(), 3_400);
    this.tickTimer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const spec of DEMO_ACTORS) {
      this.state.removeAgent(spec.id);
      this.state.clearFiredId(spec.id);
    }
    this.state.setDemoRunning(false);
  }

  private tick(): void {
    if (!this.running) return;
    this.stepCount += 1;

    const activeActors = DEMO_ACTORS.filter((a) => !this.state.isFired(a.id) && this.state.findAgent(a.id));
    if (activeActors.length === 0) return;

    const actor = activeActors[this.stepCount % activeActors.length];
    const current = this.state.findAgent(actor.id);
    if (!current || current.state === 'asking_boss' || current.state === 'fired') return;

    const thought = actor.thoughts[this.stepCount % actor.thoughts.length];
    this.state.updateUsageAndThought(actor.id, {
      thought,
      inputTokens: current.inputTokens + 420,
      outputTokens: current.outputTokens + 185
    });

    // Periodically send an actor to El Jefe's desk for interactive approval demo
    if (this.stepCount % 7 === 3 && this.state.getBossQueue().length === 0) {
      void this.state.requestBossApproval({
        agentIdOrConv: actor.id,
        kind: 'permission',
        title: `Permiso demo: ${actor.name}`,
        commandOrPrompt: 'npm run build && npm test'
      });
      return;
    }

    // Occasionally give an actor a short coffee break before returning to work
    if (this.stepCount % 9 === 5) {
      this.state.setAgentActivity(actor.id, 'coffee', 'Descansando en cafetería ☕');
      return;
    }

    const tool = actor.tools[(this.stepCount + actor.name.length) % actor.tools.length];
    const tcId = `demo_tc_${this.stepCount}`;
    this.state.recordToolStart(actor.id, tcId, tool.toolName, tool.summary, tool.file);
  }
}
