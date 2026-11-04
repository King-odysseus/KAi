import {
  securityFindingFingerprint,
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

  /**
   * Files a finding, or updates the same issue rather than appending a second row for it.
   *
   * The fingerprint is what makes a scan re-runnable: the same class at the same place with the same title is one
   * issue whether it was found on Tuesday or Thursday. A finding that was marked fixed and is seen again reopens —
   * a regression is not a new ticket — while a `wont-fix` stays as the person left it. A supplied id wins over the
   * fingerprint, which is how a verify pass re-tests the record it was asked about even if the wording changed.
   */
  async add(input: SecurityFindingSaveInput): Promise<SecurityFinding> {
    return this.serial(async () => {
      const state = await this.store.load();
      const now = this.now().toISOString();
      const fingerprint = input.fingerprint ?? securityFindingFingerprint(input);
      const existing = (input.id ? state.findings.find((finding) => finding.id === input.id) : undefined)
        ?? state.findings.find((finding) => (finding.fingerprint ?? securityFindingFingerprint(finding)) === fingerprint);

      if (!existing) {
        const finding: SecurityFinding = {
          ...input,
          id: input.id ?? randomUUID(),
          status: input.status ?? 'open',
          fingerprint,
          createdAt: now,
          lastSeenAt: now,
        };
        await this.store.save({ ...state, findings: [...state.findings, finding], updatedAt: now });
        return finding;
      }

      const updated: SecurityFinding = {
        ...existing,
        severity: input.severity,
        vulnClass: input.vulnClass,
        title: input.title,
        location: input.location,
        evidence: input.evidence,
        conceptCard: input.conceptCard,
        status: input.status ?? (existing.status === 'fixed' ? 'open' : existing.status),
        fingerprint,
        lastSeenAt: now,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.lastVerifiedAt ? { lastVerifiedAt: input.lastVerifiedAt } : {}),
      };
      const findings = state.findings.map((finding) => (finding.id === existing.id ? updated : finding));
      await this.store.save({ ...state, findings, updatedAt: now });
      return updated;
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
