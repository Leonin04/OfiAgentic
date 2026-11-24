import type {
  AgentEngine,
  AgentExecutionMode,
  AgentRole,
  DirListingResponse,
  EngineInfo,
  HireAgentPayload
} from '../../shared/protocol.js';

export interface HireModalCallbacks {
  onHire: (payload: HireAgentPayload) => Promise<boolean>;
  onBrowseDirs: (dirPath?: string) => Promise<DirListingResponse | null>;
}

export class HireAgentModal {
  private engines: EngineInfo[] = [];
  private workspaceRoot = '';
  private homeDir = '';
  private currentBrowsePath = '';
  private currentParentPath: string | null = null;
  private browserOpen = true;

  constructor(
    private readonly backdrop: HTMLElement,
    private readonly callbacks: HireModalCallbacks
  ) {
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) {
        this.close();
      }
    });
  }

  setEngines(engines: EngineInfo[]): void {
    this.engines = engines;
  }

  setContext(info: { workspaceRoot: string; homeDir: string }): void {
    this.workspaceRoot = info.workspaceRoot;
    this.homeDir = info.homeDir;
    if (!this.currentBrowsePath) {
      this.currentBrowsePath = info.workspaceRoot;
    }
  }

  open(): void {
    this.render();
    this.backdrop.classList.remove('hidden');
  }

  close(): void {
    this.backdrop.classList.add('hidden');
    this.backdrop.replaceChildren();
  }

  private render(): void {
    const card = document.createElement('div');
    card.className = 'modal-card';

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = 'Contratar Agente Independiente';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-icon';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Cerrar modal');
    closeBtn.addEventListener('click', () => this.close());
    head.appendChild(title);
    head.appendChild(closeBtn);

    const form = document.createElement('form');
    form.className = 'prompt-form';

    // Name
    const nameField = this.createField('Nombre del trabajador');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'input-control';
    nameInput.placeholder = 'Ej: Elena Frontend';
    nameInput.maxLength = 48;
    nameField.appendChild(nameInput);

    // Engine + Role grid
    const grid = document.createElement('div');
    grid.className = 'form-grid';

    const engineField = this.createField('CLI / Motor');
    const engineSelect = document.createElement('select');
    engineSelect.className = 'select-control';
    const engineList = this.engines.length
      ? this.engines
      : [{ id: 'agy' as AgentEngine, label: 'Antigravity CLI (agy)', available: true }];
    for (const eng of engineList) {
      const opt = document.createElement('option');
      opt.value = eng.id;
      opt.textContent = eng.available ? eng.label : `${eng.label} (no instalado)`;
      opt.disabled = !eng.available;
      engineSelect.appendChild(opt);
    }
    const firstAvailable = engineList.find((e) => e.available);
    if (firstAvailable) {
      engineSelect.value = firstAvailable.id;
    }
    engineField.appendChild(engineSelect);

    const roleField = this.createField('Arquetipo Visual');
    const roleSelect = document.createElement('select');
    roleSelect.className = 'select-control';
    for (const [val, label] of [
      ['builder', 'Builder (Auriculares)'],
      ['researcher', 'Researcher (Gafas)'],
      ['coordinator', 'Coordinator (Chaqueta)']
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      roleSelect.appendChild(opt);
    }
    roleField.appendChild(roleSelect);

    grid.appendChild(engineField);
    grid.appendChild(roleField);

    // Mode
    const modeField = this.createField('Modo de ejecución');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'select-control';
    for (const [val, label] of [
      ['default', 'Por defecto (recomendado)'],
      ['accept-edits', 'Accept Edits'],
      ['plan', 'Plan (solo análisis)']
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    }
    modeField.appendChild(modeSelect);

    // Root directory (cwd) picker
    const cwdField = this.createField('Carpeta raíz del proyecto (contexto)');
    const cwdInput = document.createElement('input');
    cwdInput.type = 'text';
    cwdInput.className = 'input-control';
    cwdInput.placeholder = this.workspaceRoot || '~/MiProyecto';
    cwdInput.value = this.currentBrowsePath || this.workspaceRoot;

    const dirToolbar = document.createElement('div');
    dirToolbar.className = 'dir-toolbar';

    const toggleBrowserBtn = document.createElement('button');
    toggleBrowserBtn.type = 'button';
    toggleBrowserBtn.className = 'btn btn-sm';
    toggleBrowserBtn.textContent = this.browserOpen ? '📂 Ocultar explorador' : '📁 Explorar carpetas';

    const workspaceBtn = document.createElement('button');
    workspaceBtn.type = 'button';
    workspaceBtn.className = 'btn btn-sm';
    workspaceBtn.textContent = '📍 Workspace';

    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'btn btn-sm';
    homeBtn.textContent = '🏠 Home';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn btn-sm';
    upBtn.textContent = '⬆️ Subir';
    upBtn.disabled = !this.currentParentPath;

    dirToolbar.appendChild(toggleBrowserBtn);
    dirToolbar.appendChild(workspaceBtn);
    dirToolbar.appendChild(homeBtn);
    dirToolbar.appendChild(upBtn);

    const dirBrowser = document.createElement('div');
    dirBrowser.className = this.browserOpen ? 'dir-browser' : 'dir-browser hidden';

    const loadDirectory = async (targetPath?: string): Promise<void> => {
      const listing = await this.callbacks.onBrowseDirs(targetPath);
      if (!listing) return;
      this.currentBrowsePath = listing.currentPath;
      this.currentParentPath = listing.parentPath;
      cwdInput.value = listing.currentPath;
      upBtn.disabled = !listing.parentPath;

      const nodes: HTMLElement[] = [];
      const pathLabel = document.createElement('div');
      pathLabel.className = 'dir-current-path';
      pathLabel.textContent = listing.currentPath;
      nodes.push(pathLabel);

      if (listing.directories.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-empty';
        empty.textContent = 'Sin subcarpetas (se usará esta carpeta como raíz).';
        nodes.push(empty);
      } else {
        for (const dir of listing.directories) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dir-item';
          item.textContent = `📁 ${dir.name}`;
          item.title = dir.path;
          item.addEventListener('click', () => {
            void loadDirectory(dir.path);
          });
          nodes.push(item);
        }
      }

      dirBrowser.replaceChildren(...nodes);
    };

    toggleBrowserBtn.addEventListener('click', () => {
      this.browserOpen = !this.browserOpen;
      dirBrowser.classList.toggle('hidden', !this.browserOpen);
      toggleBrowserBtn.textContent = this.browserOpen ? '📂 Ocultar explorador' : '📁 Explorar carpetas';
      if (this.browserOpen) {
        void loadDirectory(cwdInput.value.trim() || this.workspaceRoot);
      }
    });

    workspaceBtn.addEventListener('click', () => {
      if (this.workspaceRoot) {
        cwdInput.value = this.workspaceRoot;
        this.currentBrowsePath = this.workspaceRoot;
        if (this.browserOpen) {
          void loadDirectory(this.workspaceRoot);
        }
      }
    });

    homeBtn.addEventListener('click', () => {
      if (this.homeDir) {
        cwdInput.value = this.homeDir;
        this.currentBrowsePath = this.homeDir;
        if (this.browserOpen) {
          void loadDirectory(this.homeDir);
        }
      }
    });

    upBtn.addEventListener('click', () => {
      if (this.currentParentPath) {
        void loadDirectory(this.currentParentPath);
      }
    });

    cwdInput.addEventListener('change', () => {
      const val = cwdInput.value.trim();
      if (val && this.browserOpen) {
        void loadDirectory(val);
      }
    });

    cwdField.appendChild(cwdInput);
    cwdField.appendChild(dirToolbar);
    cwdField.appendChild(dirBrowser);

    // Headless permissions toggle
    const permGroup = document.createElement('div');
    permGroup.className = 'field-group';
    const permRow = document.createElement('label');
    permRow.className = 'checkbox-row';
    const skipPermCheckbox = document.createElement('input');
    skipPermCheckbox.type = 'checkbox';
    skipPermCheckbox.checked = true;
    const permText = document.createElement('span');
    permText.textContent = 'Auto-aprobar permisos en segundo plano (--dangerously-skip-permissions)';
    permRow.appendChild(skipPermCheckbox);
    permRow.appendChild(permText);

    const permHint = document.createElement('div');
    permHint.className = 'field-hint';
    permHint.textContent = 'Evita que el CLI aborte comandos o ediciones al ejecutarse en modo headless sin terminal interactiva.';

    permGroup.appendChild(permRow);
    permGroup.appendChild(permHint);

    // Prompt
    const promptField = this.createField('Tarea inicial');
    const promptInput = document.createElement('textarea');
    promptInput.className = 'textarea-control';
    promptInput.required = true;
    promptInput.placeholder = 'Describe exactamente qué quieres que haga este agente...';
    promptField.appendChild(promptInput);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', () => this.close());

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Contratar y lanzar';

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    form.appendChild(nameField);
    form.appendChild(grid);
    form.appendChild(modeField);
    form.appendChild(cwdField);
    form.appendChild(permGroup);
    form.appendChild(promptField);
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const prompt = promptInput.value.trim();
      if (!prompt) return;
      submitBtn.disabled = true;
      const chosenCwd = cwdInput.value.trim() || undefined;
      void this.callbacks
        .onHire({
          name: nameInput.value.trim(),
          engine: engineSelect.value as AgentEngine,
          role: roleSelect.value as AgentRole,
          mode: modeSelect.value as AgentExecutionMode,
          prompt,
          cwd: chosenCwd,
          skipPermissions: skipPermCheckbox.checked
        })
        .then((ok) => {
          if (ok) {
            this.close();
          }
        })
        .finally(() => {
          submitBtn.disabled = false;
        });
    });

    card.appendChild(head);
    card.appendChild(form);
    this.backdrop.replaceChildren(card);

    if (this.browserOpen) {
      void loadDirectory(cwdInput.value.trim() || this.workspaceRoot || undefined);
    }
  }

  private createField(labelText: string): HTMLElement {
    const group = document.createElement('div');
    group.className = 'field-group';
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = labelText;
    group.appendChild(label);
    return group;
  }
}
