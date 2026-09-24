import { z } from 'zod';
import { timestampSchema } from './primitives';

export const learningAssistanceSchema = z.enum(['learn', 'guided', 'pair', 'copilot']);
export type LearningAssistance = z.infer<typeof learningAssistanceSchema>;

export const learningTutorScopeSchema = z.enum(['active-file', 'project']);
export type LearningTutorScope = z.infer<typeof learningTutorScopeSchema>;

export const learningActionSchema = z.enum([
  'explain-selection',
  'explain-file',
  'hint',
  'check-code',
  'explain-error',
  'next-step',
  'complete',
]);
export type LearningAction = z.infer<typeof learningActionSchema>;

export const learningMasterySchema = z.enum([
  'introduced',
  'needs-practice',
  'developing',
  'practising',
  'independent',
]);
export type LearningMastery = z.infer<typeof learningMasterySchema>;

export const learningAnalogySchema = z
  .object({
    title: z.string().min(1).max(200),
    explanation: z.string().min(1).max(4_000),
    mappings: z.array(z.object({
      analogyPart: z.string().min(1).max(300),
      codePart: z.string().min(1).max(300),
      explanation: z.string().min(1).max(1_000),
    }).strict()).max(12),
    limits: z.string().min(1).max(2_000),
  })
  .strict();

export const learningTutorResponseSchema = z
  .object({
    title: z.string().min(1).max(200),
    recap: z.string().min(1).max(3_000),
    purpose: z.string().min(1).max(4_000),
    analogy: learningAnalogySchema,
    steps: z.array(z.object({
      title: z.string().min(1).max(200),
      explanation: z.string().min(1).max(4_000),
    }).strict()).min(1).max(7),
    concepts: z.array(z.object({
      name: z.string().min(1).max(120),
      category: z.string().min(1).max(80),
      mastery: learningMasterySchema,
      evidence: z.string().min(1).max(1_000),
    }).strict()).max(10),
    codePreview: z.string().max(40_000),
    lineByLine: z.array(z.object({
      line: z.string().max(500),
      explanation: z.string().min(1).max(2_000),
    }).strict()).max(120),
    checks: z.array(z.string().min(1).max(1_000)).max(20),
    sourceNotes: z.array(z.object({
      label: z.string().min(1).max(200),
      url: z.string().url().nullable().optional(),
    }).strict()).max(12),
    followUpQuestion: z.string().max(1_000),
    suggestion: z.object({
      code: z.string().min(1).max(20_000),
      language: z.string().max(80),
      replaceSelection: z.boolean(),
      explanation: z.string().min(1).max(2_000),
    }).strict().nullable(),
  })
  .strict();
export type LearningTutorResponse = z.infer<typeof learningTutorResponseSchema>;

export const learningTutorRequestSchema = z
  .object({
    requestId: z.string().min(1).max(160).optional(),
    projectId: z.string().min(1),
    filePath: z.string().min(1).max(1_000).optional(),
    documentVersion: z.number().int().nonnegative().optional(),
    selection: z.object({
      startLine: z.number().int().min(1).max(1_000_000),
      startColumn: z.number().int().min(1).max(1_000_000),
      endLine: z.number().int().min(1).max(1_000_000),
      endColumn: z.number().int().min(1).max(1_000_000),
    }).strict().optional(),
    language: z.string().max(80).optional(),
    scope: learningTutorScopeSchema.optional(),
    action: learningActionSchema,
    assistance: learningAssistanceSchema,
    code: z.string().max(120_000),
    selectedText: z.string().max(50_000).optional(),
    cursorLine: z.number().int().min(1).max(1_000_000).optional(),
    errorText: z.string().max(20_000).optional(),
    question: z.string().max(4_000).optional(),
  })
  .strict();
export type LearningTutorRequest = z.infer<typeof learningTutorRequestSchema>;

export const learningProviderUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    source: z.enum(['provider', 'estimated']),
  })
  .strict();
export type LearningProviderUsage = z.infer<typeof learningProviderUsageSchema>;

export const learningReadinessSchema = z
  .object({
    enabled: z.boolean(),
    supported: z.boolean(),
    ready: z.boolean(),
    provider: z.string().min(1),
    displayName: z.string().min(1),
    model: z.string(),
    protocol: z.string().min(1),
    credentialStored: z.boolean(),
    reason: z.string().nullable(),
    recovery: z.string().nullable(),
  })
  .strict();
export type LearningReadiness = z.infer<typeof learningReadinessSchema>;

export const learningConceptProgressSchema = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(120),
    category: z.string().min(1).max(80),
    mastery: learningMasterySchema,
    score: z.number().min(0).max(100),
    evidenceCount: z.number().int().nonnegative(),
    evidence: z.array(z.string().min(1).max(1_000)).max(20),
    strengths: z.array(z.string().min(1).max(500)).max(12),
    nextStep: z.string().max(1_000),
    firstSeenAt: timestampSchema,
    lastSeenAt: timestampSchema,
  })
  .strict();

export const learningEvidenceSchema = z
  .object({
    id: z.string().min(1),
    conceptName: z.string().min(1).max(120),
    mastery: learningMasterySchema,
    summary: z.string().min(1).max(1_000),
    filePath: z.string().min(1).max(1_000).optional(),
    action: learningActionSchema,
    assistance: learningAssistanceSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;

export const learningProgressSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    preferences: z.object({
      assistance: learningAssistanceSchema,
      inlineSuggestions: z.boolean(),
    }).strict(),
    concepts: z.array(learningConceptProgressSchema).max(500),
    recentEvidence: z.array(learningEvidenceSchema).max(100),
    updatedAt: timestampSchema,
  })
  .strict();
export type LearningProgress = z.infer<typeof learningProgressSchema>;

export const learningPreferencesInputSchema = z
  .object({
    projectId: z.string().min(1),
    assistance: learningAssistanceSchema,
    inlineSuggestions: z.boolean(),
  })
  .strict();
export type LearningPreferencesInput = z.infer<typeof learningPreferencesInputSchema>;

export const learningEvaluationResultSchema = z
  .object({
    response: learningTutorResponseSchema,
    progress: learningProgressSchema,
    usage: learningProviderUsageSchema.optional(),
  })
  .strict();
export type LearningEvaluationResult = z.infer<typeof learningEvaluationResultSchema>;

export const learningLessonRecordInputSchema = z
  .object({
    projectId: z.string().min(1),
    filePath: z.string().min(1).max(1_000).optional(),
    request: learningTutorRequestSchema,
    response: learningTutorResponseSchema,
  })
  .strict();
export type LearningLessonRecordInput = z.infer<typeof learningLessonRecordInputSchema>;

export const learningLessonRecordResultSchema = z
  .object({
    path: z.string().min(1),
    appended: z.boolean(),
    hash: z.string().min(1),
  })
  .strict();
export type LearningLessonRecordResult = z.infer<typeof learningLessonRecordResultSchema>;

export const teachingLibraryKindSchema = z.enum(['method', 'rule']);
export type TeachingLibraryKind = z.infer<typeof teachingLibraryKindSchema>;

const teachingLibraryEntryBaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1_000),
    content: z.string().min(1).max(120_000),
    enabled: z.boolean(),
    builtIn: z.boolean(),
    order: z.number().int().min(0).max(10_000),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const teachingMethodSchema = teachingLibraryEntryBaseSchema.extend({
  kind: z.literal('method'),
}).strict();
export type TeachingMethod = z.infer<typeof teachingMethodSchema>;

export const teachingRuleSchema = teachingLibraryEntryBaseSchema.extend({
  kind: z.literal('rule'),
}).strict();
export type TeachingRule = z.infer<typeof teachingRuleSchema>;

export const teachingLibraryEntrySchema = z.union([teachingMethodSchema, teachingRuleSchema]);
export type TeachingLibraryEntry = z.infer<typeof teachingLibraryEntrySchema>;

export const teachingLibrarySchema = z
  .object({
    schemaVersion: z.literal(1),
    directory: z.string().min(1).max(2_000),
    methods: z.array(teachingMethodSchema).max(200),
    rules: z.array(teachingRuleSchema).max(500),
    updatedAt: timestampSchema,
  })
  .strict();
export type TeachingLibrary = z.infer<typeof teachingLibrarySchema>;

export const teachingLibrarySaveInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
    kind: teachingLibraryKindSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1_000),
    content: z.string().min(1).max(120_000),
    enabled: z.boolean(),
  })
  .strict();
export type TeachingLibrarySaveInput = z.infer<typeof teachingLibrarySaveInputSchema>;

export const teachingLibraryEntryInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
    kind: teachingLibraryKindSchema,
  })
  .strict();
export type TeachingLibraryEntryInput = z.infer<typeof teachingLibraryEntryInputSchema>;

export const teachingDraftGenerateInputSchema = z
  .object({
    kind: teachingLibraryKindSchema,
    topic: z.string().trim().min(1).max(500),
    instructions: z.string().trim().max(4_000).optional(),
    baseContent: z.string().max(120_000).optional(),
  })
  .strict();
export type TeachingDraftGenerateInput = z.infer<typeof teachingDraftGenerateInputSchema>;

export const teachingDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1_000),
    content: z.string().min(1).max(120_000),
  })
  .strict();
export type TeachingDraft = z.infer<typeof teachingDraftSchema>;

export const codeFormatInputSchema = z
  .object({
    projectId: z.string().min(1),
    filePath: z.string().min(1).max(1_000),
    content: z.string().max(1_000_000),
  })
  .strict();
export type CodeFormatInput = z.infer<typeof codeFormatInputSchema>;

export const codeFormatResultSchema = z
  .object({
    formatted: z.string(),
    changed: z.boolean(),
    parser: z.string().max(80),
  })
  .strict();
export type CodeFormatResult = z.infer<typeof codeFormatResultSchema>;

export const gitFileInfoSchema = z
  .object({
    isRepository: z.boolean(),
    status: z.string().max(20),
    entries: z.array(z.object({
      hash: z.string().min(1).max(64),
      shortHash: z.string().min(1).max(16),
      author: z.string().max(200),
      date: z.string().max(80),
      subject: z.string().max(1_000),
    }).strict()).max(20),
  })
  .strict();
export type GitFileInfo = z.infer<typeof gitFileInfoSchema>;
