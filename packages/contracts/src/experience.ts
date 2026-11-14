import type { AutonomyMode } from './primitives';
import type { ReviewMode } from './review';
import { z } from 'zod';

/** A repeated, opt-in captured correction prepared for the user's review before it becomes brain memory. */
export const memoryImprovementSuggestionSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(80),
  note: z.string().min(1).max(2_000),
  occurrences: z.number().int().min(2),
  examples: z.array(z.string().max(4_000)).max(3),
  recordIds: z.array(z.string().min(1)).min(2).max(500),
}).strict();
export const memoryImprovementSuggestionReviewInputSchema = z.object({ recordIds: z.array(z.string().min(1)).min(1).max(500) }).strict();
export type MemoryImprovementSuggestion = z.infer<typeof memoryImprovementSuggestionSchema>;

/** How much help the person wants. One choice sets the safe defaults the rest of the app starts from. */
export const experienceLevelSchema = z.enum(['beginner', 'intermediate', 'expert']);
export type ExperienceLevel = z.infer<typeof experienceLevelSchema>;

export interface ExperienceProfile {
  label: string;
  summary: string;
  /** What the agent may do on its own until the person changes it. */
  autonomy: AutonomyMode;
  /** How the change review explains a diff. */
  reviewMode: ReviewMode;
  /** Whether the composer spells out what each access level can do. */
  explainAccess: boolean;
}

export const EXPERIENCE_PROFILES: Readonly<Record<ExperienceLevel, ExperienceProfile>> = {
  beginner: {
    label: 'Beginner',
    summary: 'KAI asks before it changes anything, explains each change in plain words, and spells out what every access level does.',
    autonomy: 'ask',
    reviewMode: 'novice',
    explainAccess: true,
  },
  intermediate: {
    label: 'Intermediate',
    summary: 'KAI edits files on its own and asks before risky commands. Reviews focus on responsibilities, error paths and tests.',
    autonomy: 'autoEdit',
    reviewMode: 'intermediate',
    explainAccess: false,
  },
  expert: {
    label: 'Expert',
    summary: 'Minimal hand-holding. Reviews focus on contracts, failure modes and security boundaries.',
    autonomy: 'autoEdit',
    reviewMode: 'expert',
    explainAccess: false,
  },
};

export interface AccessLevelInfo {
  value: AutonomyMode;
  label: string;
  /** What KAI can do at this level, in words a newcomer can follow. */
  description: string;
}

/** The access choices, in order from safest to most open. The composer and Settings show these same words. */
export const ACCESS_LEVELS: readonly AccessLevelInfo[] = [
  { value: 'plan', label: 'Plan only', description: 'KAI reads your project and proposes a plan. It cannot change files or run commands. The safest choice.' },
  { value: 'ask', label: 'Ask first', description: 'KAI asks your permission before each file change or command. Good while you are learning what it does.' },
  { value: 'autoEdit', label: 'Edit files', description: 'KAI edits files by itself and asks before risky commands. You can still undo any turn.' },
  { value: 'full', label: 'Full access', description: 'KAI edits files and runs commands without asking. Use it only on work you can afford to redo.' },
  { value: 'custom', label: 'Custom access', description: 'You choose exactly which actions KAI may take.' },
];

export function experienceProfile(level: ExperienceLevel | undefined): ExperienceProfile {
  return EXPERIENCE_PROFILES[level ?? 'intermediate'];
}
