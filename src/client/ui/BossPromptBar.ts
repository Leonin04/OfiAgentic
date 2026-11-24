import type { BossRequest } from '../../shared/protocol.js';

export class BossPromptBar {
  constructor(
    private readonly container: HTMLElement,
    private readonly onRespond: (requestId: string, decision: 'allow' | 'deny') => Promise<void>
  ) {}

  render(queue: BossRequest[]): void {
    if (queue.length === 0) {
      this.container.classList.add('hidden');
      this.container.replaceChildren();
      return;
    }

    const req = queue[0];
    this.container.classList.remove('hidden');

    const head = document.createElement('div');
    head.className = 'boss-banner-head';

    const title = document.createElement('span');
    title.textContent = `🛎️ ${req.agentName} acude a tu despacho (${req.title})`;

    const remainingSec = Math.max(0, Math.ceil((req.expiresAt - Date.now()) / 1000));
    const timerBadge = document.createElement('span');
    timerBadge.className = 'chip';
    timerBadge.textContent = `${remainingSec}s (cola: ${queue.length})`;

    head.appendChild(title);
    head.appendChild(timerBadge);

    const cmd = document.createElement('pre');
    cmd.className = 'boss-banner-cmd';
    cmd.textContent = req.commandOrPrompt;

    const actions = document.createElement('div');
    actions.className = 'boss-banner-actions';

    const denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'btn btn-danger';
    denyBtn.textContent = '✕ Denegar';
    denyBtn.addEventListener('click', () => {
      denyBtn.disabled = true;
      allowBtn.disabled = true;
      void this.onRespond(req.id, 'deny');
    });

    const allowBtn = document.createElement('button');
    allowBtn.type = 'button';
    allowBtn.className = 'btn btn-ok';
    allowBtn.textContent = '✓ Aprobar';
    allowBtn.addEventListener('click', () => {
      denyBtn.disabled = true;
      allowBtn.disabled = true;
      void this.onRespond(req.id, 'allow');
    });

    actions.appendChild(denyBtn);
    actions.appendChild(allowBtn);

    this.container.replaceChildren(head, cmd, actions);
  }
}
