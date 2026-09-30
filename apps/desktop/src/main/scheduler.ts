import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scheduleSchema, type Schedule, type ScheduleFrequency, type ScheduleInput } from '@kai/contracts';

const TICK_MS = 30_000;

export class ScheduleStore {
  constructor(private readonly file: string) {}

  async list(): Promise<Schedule[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown[];
      return parsed.flatMap((item) => {
        const schedule = scheduleSchema.safeParse(item);
        return schedule.success ? [schedule.data] : [];
      });
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Schedule | undefined> {
    return (await this.list()).find((schedule) => schedule.id === id);
  }

  async put(schedule: Schedule): Promise<Schedule> {
    const all = await this.list();
    const index = all.findIndex((item) => item.id === schedule.id);
    if (index >= 0) all[index] = schedule;
    else all.push(schedule);
    await this.write(all);
    return schedule;
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.list();
    const next = all.filter((schedule) => schedule.id !== id);
    if (next.length === all.length) return false;
    await this.write(next);
    return true;
  }

  private async write(schedules: Schedule[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(schedules, null, 2), 'utf8');
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}

/** The most recent moment this schedule was supposed to fire, or null when it has not come round yet. */
export function lastDueTime(frequency: ScheduleFrequency, anchor: Date, now: Date): Date | null {
  if (frequency.kind === 'interval') {
    const due = new Date(anchor.getTime() + frequency.everyMinutes * 60_000);
    return due <= now ? due : null;
  }
  const [hours, minutes] = frequency.at.split(':').map(Number) as [number, number];
  const today = new Date(now);
  today.setHours(hours, minutes, 0, 0);
  const due = today <= now ? today : new Date(today.getTime() - 24 * 60 * 60_000);
  return due > anchor ? due : null;
}

/** Whether the schedule should run now: it is on, and its next moment has arrived since it last ran. */
export function isDue(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  return lastDueTime(schedule.frequency, anchor, now) !== null;
}

/** When the schedule will next fire, for display. */
export function nextRunTime(schedule: Schedule, now: Date): Date | null {
  if (!schedule.enabled) return null;
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  if (schedule.frequency.kind === 'interval') return new Date(anchor.getTime() + schedule.frequency.everyMinutes * 60_000);
  const [hours, minutes] = schedule.frequency.at.split(':').map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return isDue(schedule, now) ? now : next;
}

export interface ScheduledRunOutcome {
  status: 'completed' | 'failed';
  summary: string;
  conversationId?: string;
}

export interface SchedulerPorts {
  /** Runs the schedule's prompt in a new conversation. Must not throw for an ordinary agent failure. */
  run(schedule: Schedule): Promise<ScheduledRunOutcome>;
  now?(): Date;
}

/**
 * Runs scheduled goals while KAI is open. A schedule that came due while KAI was closed runs once when it next
 * gets the chance; it never fires a backlog. Runs happen one at a time.
 */
export class DesktopScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: ScheduleStore,
    private readonly ports: SchedulerPorts,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async list(projectId: string): Promise<Schedule[]> {
    return (await this.store.list()).filter((schedule) => schedule.projectId === projectId);
  }

  async save(input: ScheduleInput): Promise<Schedule> {
    const existing = input.id ? await this.store.get(input.id) : undefined;
    if (input.id && !existing) throw new Error('That schedule no longer exists.');
    const now = (this.ports.now?.() ?? new Date()).toISOString();
    return this.store.put({
      ...input,
      id: existing?.id ?? `sched_${randomUUID()}`,
      createdAt: existing?.createdAt ?? now,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
      ...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {}),
      ...(existing?.lastConversationId ? { lastConversationId: existing.lastConversationId } : {}),
    });
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  /** Run one schedule now, whatever the clock says. */
  async runNow(id: string): Promise<Schedule> {
    const schedule = await this.store.get(id);
    if (!schedule) throw new Error('That schedule no longer exists.');
    if (this.running) throw new Error('A scheduled run is already in progress. Try again when it finishes.');
    return this.execute(schedule);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const now = this.ports.now?.() ?? new Date();
    const due = (await this.store.list()).find((schedule) => isDue(schedule, now));
    if (due) await this.execute(due);
  }

  private async execute(schedule: Schedule): Promise<Schedule> {
    this.running = true;
    const startedAt = (this.ports.now?.() ?? new Date()).toISOString();
    // Marked before the run so a crash mid-run cannot make the same schedule fire again on the next start.
    let current = await this.store.put({ ...schedule, lastRunAt: startedAt });
    try {
      const outcome = await this.ports.run(current);
      current = await this.store.put({
        ...current,
        lastStatus: outcome.status,
        lastSummary: outcome.summary.slice(0, 500),
        ...(outcome.conversationId ? { lastConversationId: outcome.conversationId } : {}),
      });
    } catch (error) {
      current = await this.store.put({
        ...current,
        lastStatus: 'failed',
        lastSummary: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    } finally {
      this.running = false;
    }
    return current;
  }
}
