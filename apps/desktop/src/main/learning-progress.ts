import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import {
  learningProgressSchema,
  type LearningEvidence,
  type LearningMastery,
  type LearningPreferencesInput,
  type LearningProgress,
  type LearningTutorRequest,
  type LearningTutorResponse,
} from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

// Dot-prefixed so it can never collide with a project's progress file.
const SHARED_PREFERENCES_FILE = '.preferences.json';
const sharedPreferencesSchema = z
  .object({ schemaVersion: z.literal(1), preferences: learningProgressSchema.shape.preferences })
  .strict();
type SharedPreferences = z.infer<typeof sharedPreferencesSchema>;

const masteryRank: Record<LearningMastery, number> = {
  introduced: 0,
  'needs-practice': 1,
  developing: 2,
  practising: 3,
  independent: 4,
};

interface EvaluationEvidence {
  mastery: LearningMastery;
  score: number;
  summary: string;
}

export class LearningProgressStore {
  constructor(
    private readonly directory: string,
    private readonly fileSystem: NodeFileSystem,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Progress is kept per project, but the assistance level and inline-suggestion switch are the user's own
   * preference and follow them to every project. Until a preference has been chosen once, a project keeps
   * whatever it had saved before preferences were shared.
   */
  async get(projectId: string): Promise<LearningProgress> {
    const progress = await this.store(projectId).load();
    const shared = await this.readSharedPreferences();
    return shared ? { ...progress, preferences: shared } : progress;
  }

  async updatePreferences(input: LearningPreferencesInput): Promise<LearningProgress> {
    const preferences = { assistance: input.assistance, inlineSuggestions: input.inlineSuggestions };
    await this.sharedPreferencesStore().save({ schemaVersion: 1, preferences });
    const progress = await this.store(input.projectId).load();
    const updated = learningProgressSchema.parse({
      ...progress,
      preferences,
      updatedAt: this.now().toISOString(),
    });
    await this.store(input.projectId).save(updated);
    return updated;
  }

  private async readSharedPreferences(): Promise<LearningProgress['preferences'] | null> {
    const file = path.join(this.directory, SHARED_PREFERENCES_FILE);
    if (!(await this.fileSystem.exists(file))) return null;
    try {
      return (await this.sharedPreferencesStore().load()).preferences;
    } catch {
      // An unreadable preferences file must not hide the project's own progress.
      return null;
    }
  }

  private sharedPreferencesStore(): AtomicJsonStore<SharedPreferences> {
    return new AtomicJsonStore({
      filePath: path.join(this.directory, SHARED_PREFERENCES_FILE),
      fileSystem: this.fileSystem,
      schema: sharedPreferencesSchema,
      defaultValue: () => ({ schemaVersion: 1 as const, preferences: { assistance: 'guided' as const, inlineSuggestions: false } }),
    });
  }

  async recordEvaluation(
    request: LearningTutorRequest,
    response: LearningTutorResponse,
  ): Promise<LearningProgress> {
    const progress = await this.get(request.projectId);
    const evaluation = evaluationEvidence(request);
    const createdAt = this.now().toISOString();
    const evidence = response.concepts.map((concept): LearningEvidence => ({
      id: `evidence_${createHash('sha256').update(`${request.projectId}:${request.filePath}:${request.action}:${concept.name}:${createdAt}`).digest('hex').slice(0, 24)}`,
      conceptName: concept.name,
      mastery: capMastery(concept.mastery, evaluation.mastery),
      summary: concept.evidence
        ? `${concept.evidence} (${evaluation.summary})`
        : evaluation.summary,
      filePath: request.filePath,
      action: request.action,
      assistance: request.assistance,
      createdAt,
    }));

    const concepts = [...progress.concepts];
    for (const [index, concept] of response.concepts.entries()) {
      const evidenceItem = evidence[index]!;
      const id = conceptId(concept.name, concept.category);
      const existingIndex = concepts.findIndex((candidate) => candidate.id === id);
      const existing = existingIndex >= 0 ? concepts[existingIndex] : undefined;
      const mastery = existing
        ? maxMastery(existing.mastery, capMastery(concept.mastery, evaluation.mastery))
        : capMastery(concept.mastery, evaluation.mastery);
      const score = Math.max(existing?.score ?? 0, evaluation.score);
      const strengths = uniqueBounded([
        ...(existing?.strengths ?? []),
        ...(masteryRank[mastery] >= masteryRank.developing ? [evaluation.summary] : []),
      ], 12, 500);
      const next = learningProgressSchema.shape.concepts.element.parse({
        id,
        name: concept.name,
        category: concept.category,
        mastery,
        score,
        evidenceCount: (existing?.evidenceCount ?? 0) + 1,
        evidence: [evidenceItem.summary, ...(existing?.evidence ?? [])].slice(0, 20),
        strengths,
        nextStep: response.followUpQuestion || response.checks[0] || existing?.nextStep || 'Explain the code in your own words.',
        firstSeenAt: existing?.firstSeenAt ?? createdAt,
        lastSeenAt: createdAt,
      });
      if (existingIndex >= 0) concepts[existingIndex] = next;
      else concepts.push(next);
    }

    const updated = learningProgressSchema.parse({
      ...progress,
      concepts: concepts.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)).slice(0, 500),
      recentEvidence: [...evidence, ...progress.recentEvidence].slice(0, 100),
      updatedAt: createdAt,
    });
    await this.store(request.projectId).save(updated);
    return updated;
  }

  private store(projectId: string): AtomicJsonStore<LearningProgress> {
    return new AtomicJsonStore({
      filePath: path.join(this.directory, `${safeProjectId(projectId)}.json`),
      fileSystem: this.fileSystem,
      schema: learningProgressSchema,
      defaultValue: () => ({
        schemaVersion: 1,
        projectId,
        preferences: { assistance: 'guided', inlineSuggestions: false },
        concepts: [],
        recentEvidence: [],
        updatedAt: this.now().toISOString(),
      }),
    });
  }
}

function evaluationEvidence(request: LearningTutorRequest): EvaluationEvidence {
  if (request.action === 'complete') {
    return {
      mastery: 'introduced',
      score: 20,
      summary: 'Observed an AI-generated completion; this does not by itself demonstrate learner mastery.',
    };
  }
  if (request.action === 'check-code' && !request.errorText?.trim()) {
    return {
      mastery: request.assistance === 'copilot' ? 'developing' : 'practising',
      score: request.assistance === 'copilot' ? 60 : 78,
      summary: 'Submitted code for a knowledge check without a reported runtime error.',
    };
  }
  if (request.action === 'explain-error') {
    return {
      mastery: 'developing',
      score: 52,
      summary: 'Investigated a concrete error and its cause.',
    };
  }
  if (request.action === 'hint' || request.action === 'next-step') {
    return {
      mastery: 'developing',
      score: 38,
      summary: 'Requested a guided hint or the next learning step.',
    };
  }
  return {
    mastery: 'introduced',
    score: 30,
    summary: 'Requested an explanation of the code or concept.',
  };
}

function capMastery(value: LearningMastery, cap: LearningMastery): LearningMastery {
  return masteryRank[value] <= masteryRank[cap] ? value : cap;
}

function maxMastery(left: LearningMastery, right: LearningMastery): LearningMastery {
  return masteryRank[left] >= masteryRank[right] ? left : right;
}

function conceptId(name: string, category: string): string {
  return `concept_${createHash('sha256').update(`${category.trim().toLowerCase()}:${name.trim().toLowerCase()}`).digest('hex').slice(0, 24)}`;
}

function safeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'project';
}

function uniqueBounded(values: string[], maxItems: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim().slice(0, maxLength);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= maxItems) break;
  }
  return result;
}
