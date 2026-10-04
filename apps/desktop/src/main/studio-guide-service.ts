import {
  ARTIFACT_KINDS,
  createStudioGuide,
  interviewOpenQuestions,
  studioGuideNarrativeSchema,
  studioGuideSchema,
  type AppSettings,
  type InterviewState,
  type StudioArtifacts,
  type StudioBoard,
  type StudioDesign,
  type StudioGuideNarrative,
  type StudioGuideView,
} from '@kai/contracts';
import { parseJsonResponse } from './learning-tutor';
import type { StructuredRequester } from './prompt-guide';
import type { SpecStore } from './spec-store';
import {
  STUDIO_GUIDE_PATH,
  countableForFacts,
  guideNarrativePrompt,
  guideStateKey,
  guideSteps,
  guideView,
  keepNarrative,
  recordProgress,
  type GuideFacts,
} from './studio-guide';

/**
 * The Senior Dev, wired to a real project.
 *
 * The rules live in `studio-guide.ts` and are pure; this is the half that reads a project and pays for the words.
 * The split matters at the cost boundary: `read` never calls a provider, so the board's one-line strip and every
 * redraw are free, and `explain` is the only thing that spends — once per situation, not once per look.
 */

const NAMES = { feature: 'the Senior Dev', card: 'Senior Dev' };

const GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'explanation'],
  properties: {
    headline: { type: 'string' },
    explanation: { type: 'string' },
  },
} as const;

export interface GuidePorts {
  settings(): Promise<AppSettings>;
  requester: StructuredRequester;
  spec: SpecStore;
  projectRoot(projectId: string): Promise<string>;
  /** The interview's own record, or null for a project that has not been described yet. */
  interview(projectId: string): Promise<InterviewState | null>;
  artifacts(projectId: string): Promise<StudioArtifacts>;
  board(projectId: string): Promise<StudioBoard>;
  design(projectId: string): Promise<StudioDesign>;
  now(): string;
}

export class DesktopGuideService {
  constructor(private readonly ports: GuidePorts) {}

  /**
   * Where the project is, from the rules alone. Free, so the board's strip can ask on every redraw.
   *
   * A milestone crossed is written here rather than in `explain`, because this is the call that happens whenever the
   * screen is looked at — so the history is recorded even by a reader who never opens the Guide tab.
   */
  async read(projectId: string): Promise<StudioGuideView> {
    const facts = await this.factsFor(projectId);
    const steps = guideSteps(facts);
    const { guide, changed } = recordProgress(await this.readGuide(projectId), steps, this.ports.now());
    if (changed) await this.writeGuide(projectId, guide);
    return guideView(guide, steps, facts);
  }

  /**
   * The same, with the explanation. Calls the provider only when the stored one no longer fits what is on screen —
   * so moving ten cards across the board does not cost ten explanations of the same step.
   */
  async explain(projectId: string): Promise<StudioGuideView> {
    const facts = await this.factsFor(projectId);
    const steps = guideSteps(facts);
    const key = guideStateKey(steps, facts);
    const recorded = recordProgress(await this.readGuide(projectId), steps, this.ports.now());
    let guide = recorded.guide;
    let changed = recorded.changed;

    if (guide.narrative === null || guide.narrativeFor !== key) {
      const settings = await this.ports.settings();
      const narrative = await this.ports.requester.structuredRequest(
        settings.promptGuide,
        NAMES,
        guideNarrativePrompt(facts, steps, guide.history),
        'kai_senior_dev',
        GUIDE_JSON_SCHEMA,
        parseGuideNarrative,
      );
      guide = keepNarrative(guide, narrative, key, this.ports.now());
      changed = true;
    }
    if (changed) await this.writeGuide(projectId, guide);
    return guideView(guide, steps, facts);
  }

  /** Everything the rules need, gathered once. Nothing here is inferred; each field is read from where it is kept. */
  private async factsFor(projectId: string): Promise<GuideFacts> {
    const [interview, artifacts, board, design] = await Promise.all([
      this.ports.interview(projectId).catch(() => null),
      this.ports.artifacts(projectId),
      this.ports.board(projectId),
      this.ports.design(projectId).catch(() => null),
    ]);
    const entries = artifacts.artifacts;
    const pages = design?.components.filter((component) => component.screen) ?? [];
    const onBoard = new Set(board.cards.map((item) => item.designRef).filter(Boolean));
    return {
      idea: interview?.idea ?? '',
      interview: {
        started: interview !== null,
        done: interview?.status === 'done',
        openQuestions: interview ? interviewOpenQuestions(interview).length : 0,
      },
      artifacts: {
        brief: entries.some((entry) => entry.kind === 'brief'),
        written: entries.length,
        // The catalog, not what happens to be listed: "4 of 15 written" is the useful sentence, and it stays useful
        // when an artifact is missing from the listing precisely because it was never written.
        total: ARTIFACT_KINDS.length,
        stale: entries.filter((entry) => entry.stale).length,
      },
      design: { pages: pages.length, drawn: pages.filter((page) => onBoard.has(page.id)).length },
      board: {
        total: board.cards.length,
        backlog: count(board, 'backlog'),
        ready: count(board, 'ready'),
        inProgress: count(board, 'inProgress'),
        review: count(board, 'review'),
        done: count(board, 'done'),
        blocked: count(board, 'blocked'),
        ...countableForFacts(board),
      },
    };
  }

  /** A guide file that will not parse reads as an empty one, the same way a hand-edited board does. */
  private async readGuide(projectId: string): Promise<ReturnType<typeof createStudioGuide>> {
    const root = await this.ports.projectRoot(projectId);
    const raw = await this.ports.spec.read(root, STUDIO_GUIDE_PATH);
    if (raw === null) return createStudioGuide();
    try {
      const parsed = studioGuideSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : createStudioGuide();
    } catch {
      return createStudioGuide();
    }
  }

  private async writeGuide(projectId: string, guide: ReturnType<typeof createStudioGuide>): Promise<void> {
    const root = await this.ports.projectRoot(projectId);
    await this.ports.spec.write(root, STUDIO_GUIDE_PATH, `${JSON.stringify(studioGuideSchema.parse(guide), null, 2)}\n`);
  }
}

function count(board: StudioBoard, status: StudioBoard['cards'][number]['status']): number {
  return board.cards.filter((card) => card.status === status).length;
}

/** Reads the model's reply. Anything else is an error rather than a guess, the way the interview reads its own. */
export function parseGuideNarrative(content: string): StudioGuideNarrative {
  const parsed = studioGuideNarrativeSchema.safeParse(parseJsonResponse(content, 'Senior Dev'));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The Senior Dev reply did not match the expected shape (${issue ? `${issue.path.join('.') || 'reply'}: ${issue.message}` : 'unknown error'}).`);
  }
  return parsed.data;
}
