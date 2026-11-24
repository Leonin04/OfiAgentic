import type {
  AgentSnapshot,
  BossRequest,
  DirListingResponse,
  EngineInfo,
  HireAgentPayload,
  OfficeMetrics,
  ServerWsMessage,
  SessionInfoResponse
} from '../shared/protocol.js';
import type { LightingMode } from './scene/LightingCycle.js';
import { OfficeWorld } from './scene/OfficeWorld.js';
import { BossPromptBar } from './ui/BossPromptBar.js';
import { HireAgentModal } from './ui/HireAgentModal.js';
import { InspectorPanel } from './ui/InspectorPanel.js';
import { SpeechBubbles } from './ui/SpeechBubbles.js';

interface StateHttpResponse {
  agents: AgentSnapshot[];
  bossQueue: BossRequest[];
  metrics: OfficeMetrics;
  availableEngines: EngineInfo[];
  bossGateEnabled: boolean;
  demoRunning: boolean;
}

class OfiClientApp {
  private csrfToken = '';
  private agents = new Map<string, AgentSnapshot>();
  private bossQueue: BossRequest[] = [];
  private selectedAgentId: string | null = null;
  private bossGateEnabled = false;
  private demoRunning = false;
  private ws: WebSocket | null = null;
  private wsAuthenticated = false;
  private reconnectTimer: number | null = null;
  private fallbackPollTimer: number | null = null;

  private readonly world: OfficeWorld;
  private readonly bubbles: SpeechBubbles;
  private readonly bossBar: BossPromptBar;
  private readonly inspector: InspectorPanel;
  private readonly hireModal: HireAgentModal;

  private readonly connPill = mustEl('conn-pill');
  private readonly rosterCount = mustEl('roster-count');
  private readonly rosterList = mustEl('roster-list');
  private readonly demoBtn = mustEl('btn-demo');
  private readonly bossGateBtn = mustEl('btn-boss-gate');
  private readonly toastStack = mustEl('toast-stack');

  constructor() {
    const webglCanvas = mustEl('webgl-canvas') as HTMLCanvasElement;
    const hudCanvas = mustEl('hud-canvas') as HTMLCanvasElement;

    this.bubbles = new SpeechBubbles(hudCanvas);
    this.world = new OfficeWorld(
      webglCanvas,
      (agentId) => this.selectAgent(agentId),
      () => {
        if (this.bossQueue.length > 0) {
          this.showToast('El Jefe tiene solicitudes pendientes arriba.');
        } else {
          this.showToast('Despacho de El Jefe: todo bajo control.');
        }
      }
    );

    this.bossBar = new BossPromptBar(mustEl('boss-banner'), async (requestId, decision) => {
      await this.postApi('/api/boss/respond', { requestId, decision });
    });

    this.inspector = new InspectorPanel(mustEl('inspector-panel'), {
      onClose: () => this.selectAgent(null),
      onFire: async (agentId) => {
        const res = await this.postApi(`/api/agents/${encodeURIComponent(agentId)}/fire`, {});
        if (res.ok) {
          this.showToast('Empleado despedido: recogiendo su caja...');
        }
      },
      onStopTurn: async (agentId) => {
        const res = await this.postApi(`/api/agents/${encodeURIComponent(agentId)}/stop`, {});
        if (res.ok) {
          this.showToast('Turno detenido. Puedes seguir conversando.');
        }
      },
      onSendPrompt: async (agentId, prompt) => {
        const res = await this.postApi(`/api/agents/${encodeURIComponent(agentId)}/prompt`, { prompt });
        if (res.ok) {
          this.showToast('Orden enviada al trabajador.');
        }
      }
    });

    this.hireModal = new HireAgentModal(mustEl('hire-modal'), {
      onHire: async (payload: HireAgentPayload) => {
        const res = await this.postApi('/api/agents/hire', payload);
        if (res.ok) {
          this.showToast(`Agente "${payload.name || payload.engine}" contratado.`);
        }
        return res.ok;
      },
      onBrowseDirs: async (dirPath?: string) => {
        const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
        try {
          const res = await fetch(`/api/fs/dirs${query}`, { credentials: 'same-origin' });
          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as { error?: string };
            this.showToast(errData.error || `Error ${res.status}`, true);
            return null;
          }
          return (await res.json()) as DirListingResponse;
        } catch {
          this.showToast('No se pudieron listar las carpetas del servidor.', true);
          return null;
        }
      }
    });

    this.bindToolbar();
    this.startLoop();
    void this.bootstrap();
  }

  private bindToolbar(): void {
    mustEl('btn-hire').addEventListener('click', () => this.hireModal.open());

    this.demoBtn.addEventListener('click', () => {
      void this.postApi('/api/demo/toggle', {});
    });

    this.bossGateBtn.addEventListener('click', () => {
      void this.postApi('/api/settings/boss-gate', { enabled: !this.bossGateEnabled });
    });

    mustEl('btn-rotate-cam').addEventListener('click', () => this.world.rotateCamera90());
    mustEl('btn-reset-cam').addEventListener('click', () => this.world.resetCamera());

    const lightBar = mustEl('lighting-controls');
    lightBar.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const mode = target.getAttribute('data-light') as LightingMode | null;
      if (!mode) return;
      for (const btn of lightBar.querySelectorAll('.seg-btn')) {
        btn.classList.remove('active');
      }
      target.classList.add('active');
      this.world.setLightingMode(mode);
    });
  }

  private async bootstrap(): Promise<void> {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const session = (await res.json()) as SessionInfoResponse;
      this.csrfToken = session.csrfToken;
      this.bossGateEnabled = session.bossGateEnabled;
      this.demoRunning = session.demoRunning;
      this.hireModal.setEngines(session.availableEngines);
      this.hireModal.setContext({
        workspaceRoot: session.workspaceRoot,
        homeDir: session.homeDir
      });
      this.updateSettingsUi();
      await this.fetchHttpState();
      this.setConnectionStatus('online', 'En vivo');
      this.startFallbackPolling();
      this.connectWebSocket();
    } catch {
      this.setConnectionStatus('offline', 'Sin conexión');
      this.scheduleReconnect();
    }
  }

  private async fetchHttpState(): Promise<void> {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = (await res.json()) as StateHttpResponse;
    this.applyFullSync(data);
  }

  private applyFullSync(data: StateHttpResponse): void {
    this.agents.clear();
    for (const a of data.agents) {
      this.agents.set(a.id, a);
    }
    this.bossQueue = data.bossQueue;
    this.bossGateEnabled = data.bossGateEnabled;
    this.demoRunning = data.demoRunning;
    this.hireModal.setEngines(data.availableEngines);
    this.world.syncState(data.agents, data.bossQueue, data.metrics);
    this.refreshUi();
  }

  private startFallbackPolling(): void {
    if (this.fallbackPollTimer !== null) return;
    this.fallbackPollTimer = window.setInterval(() => {
      if (!this.wsAuthenticated) {
        void this.fetchHttpState().catch(() => {
          // ignore transient poll errors
        });
      }
    }, 2_000);
  }

  private connectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    this.ws = ws;
    this.wsAuthenticated = false;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', csrfToken: this.csrfToken }));
    });

    ws.addEventListener('message', (event) => {
      let msg: ServerWsMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerWsMessage;
      } catch {
        return;
      }

      if (msg.type === 'auth_ok') {
        this.wsAuthenticated = true;
        this.setConnectionStatus('online', 'En vivo');
        return;
      }

      if (msg.type === 'state_sync') {
        this.applyFullSync(msg);
        return;
      }

      if (msg.type === 'agent_updated') {
        this.agents.set(msg.agent.id, msg.agent);
        this.world.upsertWorker(msg.agent);
        this.refreshUi();
        return;
      }

      if (msg.type === 'agent_removed') {
        this.agents.delete(msg.agentId);
        this.world.removeWorker(msg.agentId);
        if (this.selectedAgentId === msg.agentId) {
          this.selectAgent(null);
        } else {
          this.refreshUi();
        }
        return;
      }

      if (msg.type === 'boss_queue') {
        this.bossQueue = msg.bossQueue;
        this.world.setBossQueue(msg.bossQueue);
        this.bossBar.render(this.bossQueue);
        return;
      }

      if (msg.type === 'metrics') {
        this.world.updateMetrics(msg.metrics);
        return;
      }

      if (msg.type === 'settings_updated') {
        this.bossGateEnabled = msg.bossGateEnabled;
        this.demoRunning = msg.demoRunning;
        this.updateSettingsUi();
      }
    });

    ws.addEventListener('close', () => {
      this.wsAuthenticated = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.bootstrap();
    }, 2_500);
  }

  private async postApi(url: string, body: unknown): Promise<{ ok: boolean }> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': this.csrfToken
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        this.showToast(errData.error || `Error ${res.status}`, true);
        return { ok: false };
      }
      return { ok: true };
    } catch {
      this.showToast('No se pudo conectar con el servidor local.', true);
      return { ok: false };
    }
  }

  private selectAgent(agentId: string | null): void {
    this.selectedAgentId = agentId;
    this.world.setSelectedAgent(agentId);
    this.refreshUi();
  }

  private refreshUi(): void {
    this.updateSettingsUi();
    this.renderRoster();
    this.bossBar.render(this.bossQueue);
    const selected = this.selectedAgentId ? (this.agents.get(this.selectedAgentId) ?? null) : null;
    this.inspector.render(selected);
  }

  private updateSettingsUi(): void {
    this.demoBtn.classList.toggle('active', this.demoRunning);
    this.demoBtn.textContent = this.demoRunning ? '🎭 Demo: ON' : '🎭 Modo Demo';

    this.bossGateBtn.classList.toggle('active', this.bossGateEnabled);
    this.bossGateBtn.textContent = this.bossGateEnabled ? '🛡️ Firma Jefe: ON' : '🛡️ Firma Jefe: OFF';
  }

  private renderRoster(): void {
    const list = Array.from(this.agents.values()).sort((a, b) => a.createdAt - b.createdAt);
    this.rosterCount.textContent = String(list.length);

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'roster-empty';
      empty.textContent = 'Oficina tranquila. Lanza un agente en tu terminal, pulsa "+ Contratar Agente" o prueba el Modo Demo.';
      this.rosterList.replaceChildren(empty);
      return;
    }

    const items: HTMLElement[] = [];
    for (const agent of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'roster-item';
      if (agent.id === this.selectedAgentId) {
        btn.classList.add('selected');
      }

      const top = document.createElement('div');
      top.className = 'roster-item-top';

      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = agent.name;

      const badge = document.createElement('span');
      badge.className = `roster-badge badge-${agent.source}`;
      badge.textContent = agent.source;

      top.appendChild(name);
      top.appendChild(badge);

      const status = document.createElement('div');
      status.className = 'roster-status';
      status.textContent = agent.statusText || agent.state;

      btn.appendChild(top);
      btn.appendChild(status);
      btn.addEventListener('click', () => this.selectAgent(agent.id));
      items.push(btn);
    }

    this.rosterList.replaceChildren(...items);
  }

  private setConnectionStatus(kind: 'online' | 'connecting' | 'offline', label: string): void {
    this.connPill.className = `conn-pill conn-${kind}`;
    this.connPill.textContent = label;
  }

  private showToast(message: string, isError = false): void {
    const toast = document.createElement('div');
    toast.className = isError ? 'toast toast-error' : 'toast';
    toast.textContent = message;
    this.toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 3_500);
  }

  private startLoop(): void {
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;
      const projected = this.world.update(dt);
      this.bubbles.render(projected);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function mustEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el;
}

new OfiClientApp();
