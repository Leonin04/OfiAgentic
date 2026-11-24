import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDirectoryBoundary } from './security.js';
import type { StateManager } from './stateManager.js';

interface WatchedTranscript {
  filePath: string;
  conversationId: string;
  offset: number;
  leftover: string;
}

export class AgyTranscriptWatcher {
  private readonly watched = new Map<string, WatchedTranscript>();
  private readonly allowedBaseDir: string;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly state: StateManager) {
    this.allowedBaseDir = path.join(os.homedir(), '.gemini');
    this.timer = setInterval(() => this.pollAll(), 1_200);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.watched.clear();
  }

  watchTranscript(transcriptPath: string | undefined, conversationId: string): void {
    if (!transcriptPath || !conversationId) return;
    if (this.watched.has(transcriptPath)) return;

    // Restrict watched transcript files strictly inside ~/.gemini/
    const safePath = validateDirectoryBoundary(transcriptPath, this.allowedBaseDir);
    if (!safePath) return;

    let initialOffset = 0;
    try {
      const stat = fs.statSync(safePath);
      // Start near the tail (last 64KB) to hydrate current turn quickly without loading massive history
      initialOffset = Math.max(0, stat.size - 65_536);
    } catch {
      initialOffset = 0;
    }

    this.watched.set(safePath, {
      filePath: safePath,
      conversationId,
      offset: initialOffset,
      leftover: ''
    });
  }

  private pollAll(): void {
    for (const entry of this.watched.values()) {
      this.readIncremental(entry);
    }
  }

  private readIncremental(entry: WatchedTranscript): void {
    if (this.state.isFired(entry.conversationId)) {
      this.watched.delete(entry.filePath);
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(entry.filePath);
    } catch {
      return;
    }

    if (stat.size <= entry.offset) {
      if (stat.size < entry.offset) {
        entry.offset = 0;
        entry.leftover = '';
      }
      return;
    }

    const bytesToRead = Math.min(stat.size - entry.offset, 131_072);
    const buf = Buffer.alloc(bytesToRead);
    let fd: number | null = null;
    try {
      fd = fs.openSync(entry.filePath, 'r');
      fs.readSync(fd, buf, 0, bytesToRead, entry.offset);
      entry.offset += bytesToRead;
    } catch {
      return;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }

    const text = entry.leftover + buf.toString('utf8');
    const lines = text.split('\n');
    entry.leftover = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processLine(entry.conversationId, trimmed);
    }
  }

  private processLine(conversationId: string, jsonLine: string): void {
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(jsonLine);
      if (!parsed || typeof parsed !== 'object') return;
      obj = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const model = typeof obj.model === 'string' ? obj.model : undefined;
    const thinking = typeof obj.thinking === 'string' ? obj.thinking : undefined;
    const inputTokens = typeof obj.input_tokens === 'number' ? obj.input_tokens : undefined;
    const outputTokens = typeof obj.output_tokens === 'number' ? obj.output_tokens : undefined;

    if (model || thinking || inputTokens || outputTokens) {
      this.state.updateUsageAndThought(conversationId, {
        model,
        thought: thinking,
        inputTokens,
        outputTokens
      });
    }
  }
}
