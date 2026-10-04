import {
  codeGuideNarrativeSchema,
  codeGuideSchema,
  createCodeGuide,
  type AppSettings,
  type CodeGuide,
  type CodeGuideNarrative,
  type CodeGuideView,
  type CodeProjectBreakdown,
  type GitOverview,
  type LearningProgress,
  type ProjectFileEntry,
  type StudioBoard,
} from '@kai/contracts';
import { parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';
import type { SpecStore } from './spec-store';
import {
  CODE_GUIDE_PATH,
  codeGuideNarrativePrompt,
  codeGuideStateKey,
  codeGuideSteps,
  codeProjectBreakdown,
  isTestFile,
  type CodeGuideFacts,
} from './code-guide';
import { guideView, keepNarrative, recordProgress } from './guide-core';

/**
 * The Senior Dev for a code project, wired to a real folder.
 *
 * The rules live in `code-guide.ts` and are pure; this is the half that reads the project and pays for the words.
 * The split matters at the cost boundary, exactly as it does for the Studio guide: `read` never calls a provider,
 * so the strip above the editor and every redraw are free, and `explain` is the only thing that spends — once per
 * situation, not once per look.
 */

const NAMES = { feature: 'the Code guide', card: 'Code guide' };

const CODE_GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'explanation'],
  properties: {
    headline: { type: 'string' },
    explanation: { type: 'string' },
  },
} as const;

export interface CodeGuidePorts {
  settings(): Promise<AppSettings>;
  requester: StructuredRequester;
  spec: SpecStore;
  projectRoot(projectId: string): Promise<string>;
  /** The repository's own account of itself. Returns an empty overview for a folder that is not a repository. */
  git(projectId: string): Promise<GitOverview>;
  /** The project's files, flat. */
  files(projectId: string): Promise<ProjectFileEntry[]>;
  learn(projectId: string): Promise<LearningProgress>;
  /** The project's own board, from `.kai/spec/board.json`. Empty for a project that has never had one. */
  board(projectId: string): Promise<StudioBoard>;
  now(): string;
}

export class DesktopCodeGuideService {
  constructor(private readonly ports: CodeGuidePorts) {}

  /**
   * Where the project is, from the rules alone. Free, so the strip above the editor can ask whenever anything moves.
   *
   * A milestone crossed is written here rather than in `explain`, because this is the call that happens whenever
   * the screen is looked at — so the history records the work even for someone who never opens the guide panel.
   */
  async read(projectId: string): Promise<CodeGuideView> {
    const { facts, project } = await this.factsFor(projectId);
    const steps = codeGuideSteps(facts);
    const { guide, changed } = recordProgress(
      await this.readGuide(projectId),
      steps,
      this.ports.now(),
      (next) => codeGuideSchema.parse(next),
    );
    if (changed) await this.writeGuide(projectId, guide);
    return { ...guideView(guide, steps, codeGuideStateKey(steps)), project };
  }

  /**
   * The same, with the explanation. Calls the provider only when the stored one no longer fits what is on screen —
   * so committing, moving a card, or studying another concept does not cost an explanation of an unchanged
   * situation.
   */
  async explain(projectId: string): Promise<CodeGuideView> {
    const { facts, project } = await this.factsFor(projectId);
    const steps = codeGuideSteps(facts);
    const key = codeGuideStateKey(steps);
    const recorded = recordProgress(
      await this.readGuide(projectId),
      steps,
      this.ports.now(),
      (next) => codeGuideSchema.parse(next),
    );
    let guide = recorded.guide;
    let changed = recorded.changed;

    if (guide.narrative === null || guide.narrativeFor !== key) {
      const settings = await this.ports.settings();
      const narrative = await this.ports.requester.structuredRequest(
        settings.promptGuide,
        NAMES,
        codeGuideNarrativePrompt(facts, steps, guide.history, project),
        'kai_code_guide',
        CODE_GUIDE_JSON_SCHEMA,
        parseCodeGuideNarrative,
      );
      guide = keepNarrative(guide, narrative, key, this.ports.now(), (next) => codeGuideSchema.parse(next));
      changed = true;
    }
    if (changed) await this.writeGuide(projectId, guide);
    return { ...guideView(guide, steps, key), project };
  }

  /**
   * Everything the rules need, gathered once.
   *
   * Every source degrades to empty rather than throwing. This is a guide, not the screen's reason for existing: a
   * folder that has been moved, a repository too broken for git to read, or a Learn store that has never been
   * written should make this guide quieter, never make it fail. A read that throws leaves the panel on a spinner
   * forever, which is exactly the failure this guide's Studio twin had.
   */
  private async factsFor(projectId: string): Promise<{ facts: CodeGuideFacts; project: CodeProjectBreakdown }> {
    const [git, files, learn, board] = await Promise.all([
      this.ports.git(projectId).catch(() => null),
      this.ports.files(projectId).catch(() => null),
      this.ports.learn(projectId).catch(() => null),
      this.ports.board(projectId).catch(() => null),
    ]);

    const testFiles = (files ?? []).filter(isTestFile);
    const cards = board?.cards ?? [];
    const firstReady = cards.find((card) => card.status === 'ready') ?? cards.find((card) => card.status === 'inProgress');

    const facts: CodeGuideFacts = {
      git: {
        isRepository: git?.isRepository ?? false,
        branch: git?.branch ?? null,
        commits: git?.commits.length ?? 0,
        latest: git?.commits[0]?.subject ?? '',
        changed: git?.changes.length ?? 0,
        ahead: git?.ahead ?? 0,
        behind: git?.behind ?? 0,
      },
      files: {
        total: (files ?? []).length,
        tests: testFiles.length,
        firstTest: testFiles[0]?.path ?? null,
      },
      learn: {
        concepts: learn?.concepts.length ?? 0,
        weakest: weakestConcept(learn),
        recommendedNext: learn?.memory?.recommendedNext?.trim() ?? '',
      },
      board: {
        total: cards.length,
        done: count(cards, 'done'),
        ready: count(cards, 'ready'),
        inProgress: count(cards, 'inProgress'),
        review: count(cards, 'review'),
        blocked: count(cards, 'blocked'),
        nextCard: firstReady?.title ?? null,
      },
    };

    // Counted from the same flat list the steps were decided from, so the picture and the ladder can never be
    // describing two different projects.
    return { facts, project: codeProjectBreakdown(files ?? []) };
  }

  /** A guide file that will not parse reads as an empty one, the same way a hand-edited board does. */
  private async readGuide(projectId: string): Promise<CodeGuide> {
    const root = await this.ports.projectRoot(projectId);
    const raw = await this.ports.spec.read(root, CODE_GUIDE_PATH);
    if (raw === null) return createCodeGuide();
    try {
      const parsed = codeGuideSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : createCodeGuide();
    } catch {
      return createCodeGuide();
    }
  }

  private async writeGuide(projectId: string, guide: CodeGuide): Promise<void> {
    const root = await this.ports.projectRoot(projectId);
    await this.ports.spec.write(root, CODE_GUIDE_PATH, `${JSON.stringify(codeGuideSchema.parse(guide), null, 2)}\n`);
  }
}

function count(cards: readonly StudioBoard['cards'][number][], status: string): number {
  return cards.filter((card) => card.status === status).length;
}

/**
 * The concept worth naming as shaky: the lowest-scoring one that is not already independent.
 *
 * Independent concepts are left out rather than reported, because a guide that called a mastered concept weak
 * would be telling the reader something untrue about their own progress.
 */
function weakestConcept(learn: LearningProgress | null): string | null {
  const shaky = (learn?.concepts ?? []).filter((concept) => concept.mastery !== 'independent');
  if (shaky.length === 0) return null;
  return shaky.reduce((lowest, concept) => (concept.score < lowest.score ? concept : lowest)).name;
}

/** Reads the model's reply. Anything else is an error rather than a guess, the way the Studio guide reads its own. */
export function parseCodeGuideNarrative(content: string): CodeGuideNarrative {
  const parsed = codeGuideNarrativeSchema.safeParse(parseJsonResponse(content, 'the Code guide'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Code guide reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  return parsed.data;
}
