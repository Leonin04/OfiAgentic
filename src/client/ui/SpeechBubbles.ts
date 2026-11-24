import type { AgentActivityState } from '../../shared/protocol.js';
import type { BubbleProjection } from '../scene/OfficeWorld.js';

const STATE_COLOR: Record<AgentActivityState, string> = {
  spawning: '#0284c7',
  idle: '#64748b',
  planning: '#7c3aed',
  reading: '#0f766e',
  coding: '#0284c7',
  terminal: '#d97706',
  asking_boss: '#ea580c',
  error: '#dc2626',
  coffee: '#92400e',
  fired: '#991b1b',
  leaving: '#475569'
};

export class SpeechBubbles {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize 2D HUD canvas');
    }
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
  }

  private readonly resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  render(bubbles: BubbleProjection[]): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    for (const b of bubbles) {
      if (b.screenX < -120 || b.screenX > w + 120 || b.screenY < 40 || b.screenY > h + 40) {
        continue;
      }

      const nameText = b.name;
      const statusText = truncate(b.statusText || b.state, 34);

      ctx.font = '700 11px Inter, system-ui, sans-serif';
      const nameWidth = ctx.measureText(nameText).width;
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      const statusWidth = ctx.measureText(statusText).width;

      const boxW = Math.max(94, Math.min(220, Math.max(nameWidth, statusWidth) + 22));
      const boxH = 38;
      const bx = Math.round(b.screenX - boxW / 2);
      const by = Math.round(b.screenY - boxH - 12);

      // Soft drop shadow
      ctx.fillStyle = 'rgba(24, 18, 12, 0.16)';
      drawRoundedRect(ctx, bx, by + 2, boxW, boxH, 9);
      ctx.fill();

      // Card background
      ctx.fillStyle = b.state === 'fired' ? '#fef2f2' : 'rgba(255, 252, 247, 0.94)';
      drawRoundedRect(ctx, bx, by, boxW, boxH, 9);
      ctx.fill();

      ctx.lineWidth = b.selected ? 2 : 1;
      ctx.strokeStyle = b.selected ? '#0f766e' : 'rgba(120, 96, 72, 0.28)';
      ctx.stroke();

      // Little pointer triangle
      ctx.fillStyle = b.state === 'fired' ? '#fef2f2' : 'rgba(255, 252, 247, 0.94)';
      ctx.beginPath();
      ctx.moveTo(b.screenX - 5, by + boxH);
      ctx.lineTo(b.screenX + 5, by + boxH);
      ctx.lineTo(b.screenX, by + boxH + 6);
      ctx.closePath();
      ctx.fill();

      // Colored status dot + Name
      const dotColor = STATE_COLOR[b.state] ?? '#64748b';
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(bx + 10, by + 13, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#1e1b18';
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.fillText(truncate(nameText, 22), bx + 18, by + 16);

      // Action subtitle
      ctx.fillStyle = b.state === 'fired' || b.state === 'error' ? '#991b1b' : '#574c43';
      ctx.font = '500 10.5px Inter, system-ui, sans-serif';
      ctx.fillText(statusText, bx + 9, by + 30);
    }
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
