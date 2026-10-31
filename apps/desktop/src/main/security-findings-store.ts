import {
  securityFindingsLogSchema,
  type SecurityFinding,
  type SecurityFindingsLog,
  type SecurityFindingSaveInput,
  type SecurityFindingStatusUpdateInput,
} from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';
import { randomUUID } from 'node:crypto';

/**
 * The Security Auditor agent's findings log, kept separate from the teaching library on purpose: findings are
 * auto-generated and churn with every scan, while the teaching library is the person's own curated methods/rules.
 * Learn reads this log to build concept cards; it never feeds the tutor's teaching profile directly.
 */
export class SecurityFindingsStore {
  private readonly store: AtomicJsonStore<SecurityFindingsLog>;
  private mutation = Promise.resolve();

  constructor(
    filePath: string,
    fileSystem: NodeFileSystem,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: securityFindingsLogSchema,
      defaultValue: () => ({ schemaVersion: 1, findings: [], updatedAt: this.now().toISOString() }),
    });
  }

  async list(): Promise<SecurityFinding[]> {
    const { findings } = await this.store.load();
    return [...findings].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async add(input: SecurityFindingSaveInput): Promise<SecurityFinding> {
    return this.serial(async () => {
      const state = await this.store.load();
      const finding: SecurityFinding = {
        ...input,
        id: input.id ?? randomUUID(),
        status: input.status ?? 'open',
        createdAt: this.now().toISOString(),
      };
      await this.store.save({ ...state, findings: [...state.findings, finding], updatedAt: this.now().toISOString() });
      return finding;
    });
  }

  async updateStatus(input: SecurityFindingStatusUpdateInput): Promise<SecurityFinding | null> {
    return this.serial(async () => {
      const state = await this.store.load();
      let updated: SecurityFinding | null = null;
      const findings = state.findings.map((finding) => {
        if (finding.id !== input.id) return finding;
        updated = { ...finding, status: input.status, ...(input.taskId ? { taskId: input.taskId } : {}) };
        return updated;
      });
      if (!updated) return null;
      await this.store.save({ ...state, findings, updatedAt: this.now().toISOString() });
      return updated;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work, work);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
