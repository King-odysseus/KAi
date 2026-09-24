import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import { learningProviderUsageSchema, type LearningProviderUsage } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';
import type { ConversationRecord, UsageBudget } from '@kai/contracts';
import { estimateCostUsd, summarizeUsage, type ExternalPaidRun } from './usage-budget';

const learningUsageEntrySchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    timestamp: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    amountUsd: z.number().finite().nonnegative(),
    priced: z.boolean(),
    source: learningProviderUsageSchema.shape.source,
  })
  .strict();

const learningUsageCollectionSchema = z
  .object({ schemaVersion: z.literal(1), entries: z.array(learningUsageEntrySchema).max(10_000) })
  .strict();

type LearningUsageEntry = z.infer<typeof learningUsageEntrySchema>;

/** Durable provider-reported or honestly estimated Learning Mode usage, kept separate from chat conversations. */
export class LearningUsageStore {
  private readonly store: AtomicJsonStore<z.infer<typeof learningUsageCollectionSchema>>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(directory: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath: path.join(directory, 'usage.json'),
      fileSystem,
      schema: learningUsageCollectionSchema,
      defaultValue: () => ({ schemaVersion: 1, entries: [] }),
    });
  }

  async record(input: {
    projectId: string;
    provider: string;
    model: string;
    usage: LearningProviderUsage;
  }): Promise<void> {
    const write = this.writeTail.then(async () => {
      const current = await this.store.load();
      const estimated = estimateCostUsd(input.model, input.usage.inputTokens, input.usage.outputTokens);
      const amountUsd = estimated ?? 0;
      const entry: LearningUsageEntry = {
        id: `learning_${crypto.randomUUID()}`,
        projectId: input.projectId,
        provider: input.provider,
        model: input.model,
        timestamp: new Date().toISOString(),
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        amountUsd,
        priced: estimated !== null,
        source: input.usage.source,
      };
      await this.store.save({ schemaVersion: 1, entries: [...current.entries, entry].slice(-10_000) });
    });
    this.writeTail = write.catch(() => undefined);
    return write;
  }

  async runs(): Promise<ExternalPaidRun[]> {
    const collection = await this.store.load();
    return collection.entries.map((entry) => ({
      conversationId: `learning:${entry.projectId}`,
      title: 'Learning Mode',
      provider: entry.provider,
      model: entry.model,
      timestamp: Date.parse(entry.timestamp),
      usd: entry.amountUsd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      priced: entry.priced,
    }));
  }
}

/** Counts in-flight Learning Mode calls alongside completed usage before allowing another paid request. */
export class LearningBudgetGuard {
  private readonly pending = new Map<string, ExternalPaidRun>();

  reserve(input: {
    projectId: string;
    provider: string;
    model: string;
    conversations: readonly ConversationRecord[];
    budget: UsageBudget;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    externalRuns?: readonly ExternalPaidRun[];
  }): { id: string; blockedReason: string | null } {
    const estimated = estimateCostUsd(input.model, input.estimatedInputTokens, input.estimatedOutputTokens);
    const reservation: ExternalPaidRun = {
      conversationId: `learning:${input.projectId}`,
      title: 'Learning Mode request in progress',
      provider: input.provider,
      model: input.model,
      timestamp: Date.now(),
      usd: estimated ?? 0,
      inputTokens: input.estimatedInputTokens,
      outputTokens: input.estimatedOutputTokens,
      priced: estimated !== null,
    };
    const summary = summarizeUsage(
      input.conversations,
      input.budget,
      new Date(),
      undefined,
      // Include the prospective request so concurrent calls cannot all clear the same remaining budget.
      [...(input.externalRuns ?? []), ...this.pending.values(), reservation],
    );
    if (summary.blockedReason) return { id: '', blockedReason: summary.blockedReason };
    const id = `reservation_${crypto.randomUUID()}`;
    this.pending.set(id, reservation);
    return { id, blockedReason: null };
  }

  release(id: string): void {
    if (id) this.pending.delete(id);
  }
}
