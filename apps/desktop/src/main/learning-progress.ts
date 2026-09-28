import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { z } from 'zod';
import {
  learningProgressSchema,
  type LearningEvidence,
  type LearningExplainBackGrade,
  type LearningExplainBackVerdict,
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
  private writeTail: Promise<void> = Promise.resolve();

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
    return this.serialiseWrite(() => this.updatePreferencesUnlocked(input));
  }

  private async updatePreferencesUnlocked(input: LearningPreferencesInput): Promise<LearningProgress> {
    const preferences = { assistance: input.assistance, inlineSuggestions: input.inlineSuggestions, ...(input.teachingModes ? { teachingModes: input.teachingModes } : {}) };
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
    return this.serialiseWrite(() => this.recordEvaluationUnlocked(request, response));
  }

  private async recordEvaluationUnlocked(
    request: LearningTutorRequest,
    response: LearningTutorResponse,
  ): Promise<LearningProgress> {
    const progress = await this.get(request.projectId);
    const evaluation = evaluationEvidence(request);
    const createdAt = this.now().toISOString();
    const lessonId = request.requestId ?? randomUUID();
    const evidence = response.concepts.map((concept): LearningEvidence => ({
      id: `evidence_${createHash('sha256').update(`${request.projectId}:${request.filePath ?? 'project'}:${request.action}:${concept.name}:${createdAt}`).digest('hex').slice(0, 24)}`,
      conceptName: concept.name,
      mastery: capMastery(concept.mastery, evaluation.mastery),
      summary: concept.evidence
        ? `${concept.evidence} (${evaluation.summary})`
        : evaluation.summary,
      ...(request.filePath ? { filePath: request.filePath } : {}),
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
      lessons: [{ id: lessonId, createdAt, ...(request.filePath ? { filePath: request.filePath } : {}), response, understood: false }, ...(progress.lessons ?? []).filter((lesson) => lesson.id !== lessonId)].slice(0, 30),
      memory: {
        lessonId,
        lastLesson: response.title,
        ...(request.filePath ? { filePath: request.filePath } : {}),
        unresolvedCheck: response.checks[0] ?? '',
        recommendedNext: response.followUpQuestion || response.steps[0]?.explanation.slice(0, 1_000) || '',
        understood: false,
      },
      updatedAt: createdAt,
    });
    await this.store(request.projectId).save(updated);
    return updated;
  }

  async markUnderstood(projectId: string, lessonId: string): Promise<LearningProgress> {
    return this.serialiseWrite(async () => {
      const progress = await this.get(projectId);
      if (progress.memory?.lessonId !== lessonId && !progress.lessons?.some((lesson) => lesson.id === lessonId)) throw new Error('This lesson is no longer available.');
      const updated = { ...progress, lessons: progress.lessons?.map((lesson) => lesson.id === lessonId ? { ...lesson, understood: true } : lesson), memory: progress.memory?.lessonId === lessonId ? { ...progress.memory, understood: true, unresolvedCheck: '' } : progress.memory, updatedAt: this.now().toISOString() };
      // Self-report resolves the lesson check; it does not award demonstrated mastery.
      await this.store(projectId).save(updated);
      return updated;
    });
  }

  /**
   * An explanation in the learner's own words is stronger evidence than a self-report: a solid answer
   * resolves the lesson and lifts its concepts to practising, a partial one to developing, and a missing
   * one leaves mastery alone but records what to revisit.
   */
  async recordExplanation(projectId: string, lessonId: string, question: string, grade: LearningExplainBackGrade): Promise<LearningProgress> {
    return this.serialiseWrite(async () => {
      const progress = await this.get(projectId);
      const lesson = progress.lessons?.find((candidate) => candidate.id === lessonId);
      if (!lesson) throw new Error('This lesson is no longer available.');
      const answeredAt = this.now().toISOString();
      const solid = grade.verdict === 'solid';
      const award = explanationEvidence[grade.verdict];
      const summary = `${award.summary}: ${question}`.slice(0, 1_000);
      const concepts = progress.concepts.map((concept) => {
        if (!lesson.response.concepts.some((taught) => conceptId(taught.name, taught.category) === concept.id)) return concept;
        return {
          ...concept,
          mastery: award.mastery ? maxMastery(concept.mastery, award.mastery) : concept.mastery,
          score: Math.max(concept.score, award.score),
          evidenceCount: concept.evidenceCount + 1,
          evidence: [summary, ...concept.evidence].slice(0, 20),
          strengths: solid ? uniqueBounded([...concept.strengths, summary], 12, 500) : concept.strengths,
          nextStep: grade.gap.trim() ? grade.gap.slice(0, 1_000) : concept.nextStep,
          lastSeenAt: answeredAt,
        };
      });
      const updated = learningProgressSchema.parse({
        ...progress,
        concepts,
        lessons: progress.lessons?.map((candidate) => candidate.id === lessonId
          ? { ...candidate, understood: candidate.understood || solid, explainBack: { verdict: grade.verdict, feedback: grade.feedback, answeredAt } }
          : candidate),
        memory: progress.memory?.lessonId === lessonId
          ? { ...progress.memory, understood: progress.memory.understood || solid, unresolvedCheck: solid ? '' : (grade.gap || progress.memory.unresolvedCheck).slice(0, 1_000) }
          : progress.memory,
        updatedAt: answeredAt,
      });
      await this.store(projectId).save(updated);
      return updated;
    });
  }

  private serialiseWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
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

const explanationEvidence: Record<LearningExplainBackVerdict, { mastery: LearningMastery | null; score: number; summary: string }> = {
  solid: { mastery: 'practising', score: 72, summary: 'Explained it back correctly in own words' },
  partial: { mastery: 'developing', score: 50, summary: 'Explained it back with a gap' },
  missing: { mastery: null, score: 0, summary: 'Could not yet explain it back' },
};

function evaluationEvidence(request: LearningTutorRequest): EvaluationEvidence {
  if (request.hintLevel === 3) {
    return {
      mastery: 'introduced',
      score: 25,
      summary: 'Needed the full answer after two hints.',
    };
  }
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
