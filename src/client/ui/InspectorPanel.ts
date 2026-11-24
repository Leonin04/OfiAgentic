import type { AgentSnapshot } from '../../shared/protocol.js';

export class InspectorPanel {
  private currentAgentId: string | null = null;
  private confirmingFire = false;
  private draftPrompt = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: {
      onClose: () => void;
      onFire: (agentId: string) => Promise<void>;
      onStopTurn: (agentId: string) => Promise<void>;
      onSendPrompt: (agentId: string, prompt: string) => Promise<void>;
    }
  ) {}

  render(agent: AgentSnapshot | null): void {
    if (!agent) {
      this.currentAgentId = null;
      this.confirmingFire = false;
      this.draftPrompt = '';
      this.container.classList.add('hidden');
      this.container.replaceChildren();
      return;
    }

    if (this.currentAgentId !== agent.id) {
      this.currentAgentId = agent.id;
      this.confirmingFire = false;
      this.draftPrompt = '';
    }

    this.container.classList.remove('hidden');

    // Header
    const head = document.createElement('div');
    head.className = 'inspector-head';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h2');
    title.className = 'inspector-title';
    title.textContent = agent.name;

    const meta = document.createElement('div');
    meta.className = 'inspector-meta';

    const chips = [
      `Rol: ${agent.role}`,
      `Origen: ${agent.source}`,
      `Modelo: ${agent.model}`,
      `Estado: ${agent.state}`,
      `Tokens: ${agent.inputTokens + agent.outputTokens}`
    ];
    for (const label of chips) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = label;
      meta.appendChild(chip);
    }
    if (agent.cwd) {
      const cwdBase = agent.cwd.split(/[\\/]/).filter(Boolean).pop() || agent.cwd;
      const cwdChip = document.createElement('span');
      cwdChip.className = 'chip';
      cwdChip.textContent = `📁 ${cwdBase}`;
      cwdChip.title = agent.cwd;
      meta.appendChild(cwdChip);
    }

    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-icon';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Cerrar inspector');
    closeBtn.addEventListener('click', () => this.callbacks.onClose());

    head.appendChild(titleWrap);
    head.appendChild(closeBtn);

    const nodes: HTMLElement[] = [head];

    // Stop Turn & Fire / Kill Worker section
    const isBusy =
      agent.state === 'spawning' ||
      agent.state === 'planning' ||
      agent.state === 'reading' ||
      agent.state === 'coding' ||
      agent.state === 'terminal' ||
      agent.state === 'asking_boss';
    const canStopTurn =
      isBusy && (agent.source === 'web' || agent.source === 'agy' || agent.source === 'claude');

    if (canStopTurn && agent.state !== 'fired' && agent.state !== 'leaving') {
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'btn btn-warn';
      stopBtn.textContent = '⏹ Detener turno actual (seguir conversación)';
      stopBtn.addEventListener('click', () => {
        stopBtn.disabled = true;
        void this.callbacks.onStopTurn(agent.id).finally(() => {
          stopBtn.disabled = false;
        });
      });
      nodes.push(stopBtn);
    }

    if (agent.canFire && agent.state !== 'fired') {
      const fireBox = document.createElement('div');
      fireBox.className = 'fire-box';

      if (!this.confirmingFire) {
        const fireBtn = document.createElement('button');
        fireBtn.type = 'button';
        fireBtn.className = 'btn btn-danger';
        fireBtn.textContent = agent.isRootSession
          ? '🚪 Sacar de la oficina (cortar turno actual)'
          : '🔥 Despedir empleado (matar agente)';
        fireBtn.addEventListener('click', () => {
          this.confirmingFire = true;
          this.render(agent);
        });
        fireBox.appendChild(fireBtn);
      } else {
        const row = document.createElement('div');
        row.className = 'fire-confirm-row';

        const msg = document.createElement('span');
        msg.textContent = agent.isRootSession
          ? '¿Cortar turno actual y sacar de la oficina? Podrás seguir escribiendo en tu chat.'
          : '¿Despedir y terminar solo este agente?';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'toolbar-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.addEventListener('click', () => {
          this.confirmingFire = false;
          this.render(agent);
        });

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn btn-danger';
        confirmBtn.textContent = agent.isRootSession ? 'Sí, sacar' : 'Sí, despedir';
        confirmBtn.addEventListener('click', () => {
          confirmBtn.disabled = true;
          this.confirmingFire = false;
          void this.callbacks.onFire(agent.id);
        });

        btnGroup.appendChild(cancelBtn);
        btnGroup.appendChild(confirmBtn);
        row.appendChild(msg);
        row.appendChild(btnGroup);
        fireBox.appendChild(row);
      }

      nodes.push(fireBox);
    }

    // Thought preview
    const thoughtSec = document.createElement('section');
    const thoughtTitle = document.createElement('h3');
    thoughtTitle.className = 'inspector-section-title';
    thoughtTitle.textContent = 'Pensamiento / Actividad';
    const thoughtBox = document.createElement('pre');
    thoughtBox.className = 'thought-box';
    thoughtBox.textContent = agent.thoughtPreview || agent.statusText || 'Sin pensamientos registrados aún.';
    thoughtSec.appendChild(thoughtTitle);
    thoughtSec.appendChild(thoughtBox);
    nodes.push(thoughtSec);

    // Recent tools
    const toolsSec = document.createElement('section');
    const toolsTitle = document.createElement('h3');
    toolsTitle.className = 'inspector-section-title';
    toolsTitle.textContent = `Herramientas (${agent.recentTools.length})`;
    const toolsList = document.createElement('div');
    toolsList.className = 'tools-list';

    if (agent.recentTools.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'roster-status';
      empty.textContent = 'Esperando primera herramienta...';
      toolsList.appendChild(empty);
    } else {
      for (const tool of agent.recentTools.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'tool-row';

        const sum = document.createElement('span');
        sum.className = 'tool-summary';
        sum.textContent = tool.summary;

        const st = document.createElement('span');
        st.className = `tool-status tool-status-${tool.status}`;
        st.textContent = tool.status === 'running' ? '⏳' : tool.status === 'done' ? '✓' : '✕';

        row.appendChild(sum);
        row.appendChild(st);
        toolsList.appendChild(row);
      }
    }
    toolsSec.appendChild(toolsTitle);
    toolsSec.appendChild(toolsList);
    nodes.push(toolsSec);

    // Touched files
    if (agent.touchedFiles.length > 0) {
      const filesSec = document.createElement('section');
      const filesTitle = document.createElement('h3');
      filesTitle.className = 'inspector-section-title';
      filesTitle.textContent = 'Archivos recientes';
      const wrap = document.createElement('div');
      wrap.className = 'files-wrap';
      for (const file of agent.touchedFiles) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = file;
        wrap.appendChild(chip);
      }
      filesSec.appendChild(filesTitle);
      filesSec.appendChild(wrap);
      nodes.push(filesSec);
    }

    // Prompt form for web-spawned independent agents
    if (agent.canPrompt && agent.state !== 'fired') {
      const formSec = document.createElement('section');
      const formTitle = document.createElement('h3');
      formTitle.className = 'inspector-section-title';
      formTitle.textContent = 'Enviar nueva orden al agente';

      const form = document.createElement('form');
      form.className = 'prompt-form';

      const textarea = document.createElement('textarea');
      textarea.className = 'textarea-control';
      textarea.placeholder = 'Escribe una tarea o instrucción de seguimiento...';
      textarea.value = this.draftPrompt;
      textarea.addEventListener('input', () => {
        this.draftPrompt = textarea.value;
      });

      const sendBtn = document.createElement('button');
      sendBtn.type = 'submit';
      sendBtn.className = 'btn btn-primary';
      sendBtn.textContent = 'Enviar orden';

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        this.draftPrompt = '';
        void this.callbacks.onSendPrompt(agent.id, text).finally(() => {
          sendBtn.disabled = false;
        });
      });

      form.appendChild(textarea);
      form.appendChild(sendBtn);
      formSec.appendChild(formTitle);
      formSec.appendChild(form);
      nodes.push(formSec);
    }

    this.container.replaceChildren(...nodes);
  }
}
