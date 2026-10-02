import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AutoWindowPort } from './auto-session';

/**
 * When each CLI agent's usage window reopens, remembered across restarts.
 *
 * The window belongs to the subscription, not to one conversation, so this is keyed by agent id. Without it, an app
 * restart in the middle of a spent window would spend a real request just to be told the same thing again.
 */
export class AutoWindowStore implements AutoWindowPort {
  constructor(private readonly file: string) {}

  /** The reopen time for an agent, or null when it is unknown or already past. */
  async resumeAt(agentId: string, now: number = Date.now()): Promise<string | null> {
    const all = await this.read();
    const at = all[agentId];
    if (!at) return null;
    if (Date.parse(at) <= now) {
      await this.clear(agentId);
      return null;
    }
    return at;
  }

  async set(agentId: string, iso: string): Promise<void> {
    const all = await this.read();
    all[agentId] = iso;
    await this.write(all);
  }

  async clear(agentId: string): Promise<void> {
    const all = await this.read();
    if (!(agentId in all)) return;
    delete all[agentId];
    await this.write(all);
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [agent, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && Number.isFinite(Date.parse(value))) out[agent] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async write(all: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(all, null, 2), 'utf8');
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}
