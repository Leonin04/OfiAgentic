import * as THREE from 'three';
import type { OfficeMetrics } from '../../shared/protocol.js';
import { COZY_PALETTE, createVoxelBox } from './VoxelBuilder.js';

export class MetricsWall {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastDrawAt = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 420;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create 2D context for MetricsWall');
    }
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // Frame bezel
    const frame = createVoxelBox(9.2, 3.8, 0.22, COZY_PALETTE.slateDark, {
      x: 0,
      y: 2.8,
      z: -11.65
    });
    this.group.add(frame);

    const screenGeo = new THREE.PlaneGeometry(8.7, 3.4);
    const screenMat = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.45,
      roughness: 0.35,
      metalness: 0.1
    });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 2.8, -11.52);
    this.group.add(screen);

    this.draw(
      {
        activeAgents: 0,
        loungingAgents: 0,
        totalToolsRun: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        deskCapacity: 4,
        bySource: { agy: 0, claude: 0, custom: 0, web: 0, demo: 0 },
        activityHistory: new Array(20).fill(0)
      },
      'Día'
    );
  }

  update(metrics: OfficeMetrics, phaseLabel: string, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastDrawAt < 1_000) return;
    this.lastDrawAt = now;
    this.draw(metrics, phaseLabel);
  }

  private draw(metrics: OfficeMetrics, phaseLabel: string): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.fillStyle = '#141923';
    ctx.fillRect(0, 0, w, h);

    // Subtle grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Header
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 30px Inter, system-ui, sans-serif';
    ctx.fillText('OFIAGENTIC // CENTRAL DE OPERACIONES', 34, 52);

    const timeStr = new Date().toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 24px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${timeStr} · ${phaseLabel}`, w - 34, 50);
    ctx.textAlign = 'left';

    // 4 KPI Cards
    const cards = [
      { label: 'ACTIVOS', value: String(metrics.activeAgents), color: '#38bdf8' },
      { label: 'CAFETERÍA', value: String(metrics.loungingAgents), color: '#fbbf24' },
      { label: 'TOOLS EJECUTADAS', value: String(metrics.totalToolsRun), color: '#34d399' },
      {
        label: 'TOKENS (IN/OUT)',
        value: `${formatCompact(metrics.totalInputTokens)} / ${formatCompact(metrics.totalOutputTokens)}`,
        color: '#c084fc'
      }
    ];

    const cardW = 225;
    const cardH = 115;
    cards.forEach((c, idx) => {
      const cx = 34 + idx * 242;
      const cy = 84;
      ctx.fillStyle = '#1e2636';
      roundRect(ctx, cx, cy, cardW, cardH, 14);
      ctx.fill();

      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 16px Inter, system-ui, sans-serif';
      ctx.fillText(c.label, cx + 18, cy + 34);

      ctx.fillStyle = c.color;
      ctx.font = 'bold 36px ui-monospace, monospace';
      ctx.fillText(c.value, cx + 18, cy + 86);
    });

    // Activity Sparkline
    const chartX = 34;
    const chartY = 228;
    const chartW = 620;
    const chartH = 156;
    ctx.fillStyle = '#1e2636';
    roundRect(ctx, chartX, chartY, chartW, chartH, 14);
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 16px Inter, system-ui, sans-serif';
    ctx.fillText('PULSO DE ACTIVIDAD EN VIVO', chartX + 18, chartY + 32);

    const hist = metrics.activityHistory.length ? metrics.activityHistory : [0];
    const maxVal = Math.max(4, ...hist);
    const barW = (chartW - 48) / hist.length;
    hist.forEach((val, idx) => {
      const bh = Math.max(4, ((val / maxVal) * (chartH - 64)));
      const bx = chartX + 24 + idx * barW;
      const by = chartY + chartH - 18 - bh;
      ctx.fillStyle = val > 0 ? '#38bdf8' : '#334155';
      roundRect(ctx, bx + 2, by, Math.max(4, barW - 6), bh, 4);
      ctx.fill();
    });

    // Breakdown by CLI / Source
    const srcX = 678;
    const srcY = 228;
    const srcW = 312;
    const srcH = 156;
    ctx.fillStyle = '#1e2636';
    roundRect(ctx, srcX, srcY, srcW, srcH, 14);
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 16px Inter, system-ui, sans-serif';
    ctx.fillText(`CAPACIDAD: ${metrics.deskCapacity} MESAS`, srcX + 18, srcY + 32);

    const rows: Array<[string, number, string]> = [
      ['Antigravity (agy)', metrics.bySource.agy + metrics.bySource.web, '#38bdf8'],
      ['Claude Code', metrics.bySource.claude, '#fb923c'],
      ['Scripts / Demo', metrics.bySource.custom + metrics.bySource.demo, '#34d399']
    ];

    rows.forEach(([label, count, color], idx) => {
      const ry = srcY + 66 + idx * 32;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(srcX + 26, ry - 5, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '18px Inter, system-ui, sans-serif';
      ctx.fillText(label, srcX + 42, ry);

      ctx.fillStyle = color;
      ctx.font = 'bold 20px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(count), srcX + srcW - 22, ry);
      ctx.textAlign = 'left';
    });

    this.texture.needsUpdate = true;
  }
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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
