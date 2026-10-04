import {
  codeGuideStepSchema,
  codeProjectBreakdownSchema,
  createCodeGuide,
  type CodeGuide,
  type CodeGuideStep,
  type CodeProjectBreakdown,
  type ProjectFileEntry,
} from '@kai/contracts';

/**
 * The Senior Dev for a folder of source code: what to do next, decided by rules.
 *
 * The twin of `studio-guide.ts`, and the same discipline: every judgement here is made from facts the project
 * already holds — the repository, the files, what has been studied, the board — so it is free, instant, and cannot
 * be wrong about the project. The model is asked only for the words.
 *
 * What it deliberately does NOT do is invent steps it cannot see the end of. There is no "run the app" step and no
 * "the tests pass" step, because nothing here can observe either — and a guide that claims you have not finished
 * something it cannot check is worse than one that stays quiet. Every step below is either decided by a fact on
 * disk or is the reader's own work, named so they know it is theirs.
 *
 * This file has no ports and no IO, which is what lets the whole ladder be tested without a repository, a disk or a
 * provider — the same property `studio-guide.ts` has, for the same reason.
 */

export const CODE_GUIDE_PATH = 'code-guide.json';

/** What the guide is told about one project. Gathered by the caller, never fetched from here. */
export interface CodeGuideFacts {
  git: {
    isRepository: boolean;
    branch: string | null;
    /** Commits reachable from HEAD, capped by what `gitOverview` reads. Enough to distinguish none from some. */
    commits: number;
    /** The subject of the newest commit, for the sentence that says what was last done. */
    latest: string;
    /** Files changed but not committed. */
    changed: number;
    ahead: number;
    behind: number;
  };
  files: {
    total: number;
    /** Files that look like tests. We can see that they exist; we cannot see that they pass, and do not claim to. */
    tests: number;
    firstTest: string | null;
  };
  learn: {
    concepts: number;
    /** The lowest-scoring concept, named so the step says something specific rather than "keep learning". */
    weakest: string | null;
    recommendedNext: string;
  };
  board: {
    total: number;
    done: number;
    ready: number;
    inProgress: number;
    review: number;
    blocked: number;
    nextCard: string | null;
  };
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * A file that looks like a test, by the conventions every ecosystem shares.
 *
 * Reading the file to find out whether it really tests anything is not something this can afford on every redraw,
 * and does not need to: the step is "have a way to check your work", and a file that looks like a test is the
 * closest honest proxy for that.
 */
export function isTestFile(entry: ProjectFileEntry): boolean {
  const path = entry.path.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  return (
    // A folder named for testing anywhere in the path, including at the top of it.
    /(^|\/)(test|tests|__tests__|spec)\//.test(path)
    || /\.(test|spec)\.[a-z0-9]+$/.test(name)
    || /(^|[-_.])test[-_][a-z0-9]+\./i.test(name)
  );
}

/**
 * The name a language is known by, from the extension of the files that use it.
 *
 * Only the families worth a row are here. A file whose extension is not in the map is still counted in `files` and
 * still placed in its area — it simply does not get a language row, which is why the language counts do not have to
 * add up to the file count.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.rb': 'Ruby', '.php': 'PHP',
  '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.cs': 'C#',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.hpp': 'C++', '.cc': 'C++',
  '.css': 'CSS', '.scss': 'Sass', '.less': 'Less', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.md': 'Markdown', '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.sql': 'SQL',
  '.sh': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch',
};

/** How much of the project the picture may show. A longer list is a worse picture, not a more complete one. */
const AREA_LIMIT = 12;
const LANGUAGE_LIMIT = 8;

/** The extension of a path, lower-cased, or the empty string when the last dot is part of a directory name. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
}

/**
 * What the project is made of, counted from its file paths.
 *
 * Pure and free, like the steps: it reads the same flat file list the Code screen already has, so the panel can carry
 * a picture of the project without a second walk of the disk or a model call. Files are grouped by their top-level
 * directory, which is the level at which a project's shape is decided — `src`, `test`, `apps`, `docs` — rather than by
 * where each file happens to sit.
 */
export function codeProjectBreakdown(files: readonly ProjectFileEntry[]): CodeProjectBreakdown {
  const areas = new Map<string, { files: number; tests: number }>();
  const languages = new Map<string, number>();

  for (const entry of files) {
    const slash = entry.path.indexOf('/');
    const area = slash === -1 ? '.' : entry.path.slice(0, slash);
    const counts = areas.get(area) ?? { files: 0, tests: 0 };
    counts.files += 1;
    if (isTestFile(entry)) counts.tests += 1;
    areas.set(area, counts);

    const language = LANGUAGE_BY_EXTENSION[extensionOf(entry.path)];
    if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
  }

  // The name breaks every tie, so the same folder always draws the same list. Without it the order would depend on
  // which file the walk happened to reach first, and the panel would reshuffle itself between reads.
  const areasSorted = [...areas]
    .map(([path, counts]) => ({ path, ...counts }))
    .sort((right, left) => (left.files - right.files) || right.path.localeCompare(left.path));
  const languagesSorted = [...languages]
    .map(([label, files]) => ({ label, files }))
    .sort((right, left) => (left.files - right.files) || right.label.localeCompare(left.label));

  return codeProjectBreakdownSchema.parse({
    files: files.length,
    areas: areasSorted.slice(0, AREA_LIMIT),
    languages: languagesSorted.slice(0, LANGUAGE_LIMIT),
  });
}

/**
 * The steps this project actually has, in order, each carrying the one thing to press.
 *
 * Order is the priority: the first step that is not done is where the project is. `clean` sits late on purpose —
 * an uncommitted tree is the normal state while working, so a guide that led with it would nag, and because it
 * would flip back to unfinished on every edit it would keep pulling the project backwards.
 *
 * Unlike the Studio guide there is no `blocked` state. There, "blocked" means cards a machine parked and a person
 * has to unpark — a distinction worth its own word. Here every unfinished step is already the reader's own to do,
 * so marking them all "needs you" would say nothing. The detail line carries the nuance in words instead.
 */
export function codeGuideSteps(facts: CodeGuideFacts): CodeGuideStep[] {
  const { git, files, learn, board } = facts;
  const raw: Array<Omit<CodeGuideStep, 'state'> & { done: boolean }> = [
    {
      id: 'versioned',
      title: 'Put the project under version control',
      why: 'Version control is the undo history for a whole project; without it a mistake has no way back.',
      detail: git.isRepository
        ? `A repository${git.branch ? ` on ${git.branch}` : ''}, with ${plural(git.commits, 'commit')}.`
        : 'This folder is not a Git repository yet.',
      // Offered only when it would do something: on a project that is already a repository there is nothing to press.
      action: git.isRepository ? null : 'init-git',
      actionLabel: git.isRepository ? null : 'Start version control',
      done: git.isRepository,
    },
    {
      id: 'committed',
      title: 'Save your first checkpoint',
      why: 'A commit is a point you can return to, and the first one is what makes everything after it safe to try.',
      detail: !git.isRepository
        ? 'Waiting for version control.'
        : git.commits > 0
          ? `Last save: “${git.latest}”.`
          : 'The repository has no commits yet — this is where it gets its first one.',
      action: null,
      actionLabel: null,
      done: git.isRepository && git.commits > 0,
    },
    {
      id: 'understood',
      title: 'Understand a piece of the code',
      why: 'Changing code you have not read is how bugs get added; understanding one piece properly pays for itself at once.',
      detail: learn.concepts > 0
        ? `${plural(learn.concepts, 'concept')} recorded${learn.weakest ? `; the shakiest is ${learn.weakest}` : ''}.`
        : 'Nothing has been studied yet. The Learn panel picks a place to start.',
      action: learn.concepts > 0 ? null : 'open-learn',
      actionLabel: learn.concepts > 0 ? null : 'Open Learn',
      done: learn.concepts > 0,
    },
    {
      id: 'tested',
      title: 'Have a way to check your work',
      why: 'A test is how you find out you broke something without waiting for a person to notice.',
      detail: files.tests > 0
        ? `${plural(files.tests, 'test file')} found${files.firstTest ? `, such as ${files.firstTest}` : ''}.`
        : 'No test files found. This step is about having one at all, not about it passing.',
      action: null,
      actionLabel: null,
      done: files.tests > 0,
    },
    {
      id: 'board',
      title: 'Work the cards on the board',
      why: 'The cards are work that was thought through in advance, so nothing has to be decided while typing.',
      detail: `${board.done} of ${plural(board.total, 'card')} done${
        board.nextCard ? `; next up is ${board.nextCard}` : ''
      }.`,
      action: null,
      actionLabel: null,
      done: board.total > 0 && board.done === board.total,
    },
    {
      id: 'clean',
      title: 'Commit the changes you have',
      why: 'Uncommitted work has no checkpoint, so a wrong edit has nothing to fall back to.',
      detail: !git.isRepository
        ? 'Waiting for version control.'
        : git.changed > 0
          ? `${plural(git.changed, 'file')} changed and not committed yet.`
          : 'Nothing is waiting to be committed.',
      action: null,
      actionLabel: null,
      done: git.isRepository && git.changed === 0,
    },
  ];

  // A project with no cards never meets the board step, so it is left out rather than shown as a permanent
  // reminder of something the project does not have — the same reason the Studio guide drops its design step.
  const applicable = raw.filter((step) => step.id !== 'board' || board.total > 0);

  // The last step is true only once everything that applies is done, which is why it is built after the filter:
  // a project with no board must still be able to reach the end.
  const allDone = applicable.every((step) => step.done);
  const ready: Omit<CodeGuideStep, 'state'> & { done: boolean } = {
    id: 'ready',
    title: 'Everything is in order',
    why: 'Every step above is done, so the project is in a state someone else could pick up.',
    detail: allDone ? nextThing(facts) : `Waiting on ${plural(applicable.filter((step) => !step.done).length, 'step')}.`,
    action: null,
    actionLabel: null,
    done: allDone,
  };

  const all = [...applicable, ready];
  const currentIndex = all.findIndex((step) => !step.done);
  return all.map((step, index) => {
    // Position decides the state, not the fact on its own. A step's condition can hold before the project has
    // reached it — a project with a clean tree meets "commit the changes you have" while it is still on "understand a
    // piece of the code" — and reporting that as done would both claim an achievement the reader has not made and
    // write a false line into the history. Steps ahead of where the project is are ahead of it.
    // `currentIndex` is -1 when nothing is left, which is the finished project: every step is done, and the view
    // falls back to the last one.
    const state = currentIndex === -1 || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
    const { done: _done, ...rest } = step;
    return codeGuideStepSchema.parse({ ...rest, state });
  });
}

/** What is actually worth doing once nothing on the ladder is waiting — the panel's own next list, not a new one. */
function nextThing(facts: CodeGuideFacts): string {
  if (facts.board.nextCard) return `Nothing here is waiting. On the board: ${facts.board.nextCard}.`;
  if (facts.learn.recommendedNext) return `Nothing here is waiting. The Learn panel suggests: ${facts.learn.recommendedNext}.`;
  return 'Nothing is waiting.';
}

/**
 * The situation the explanation was written for: which step the project is on, and nothing else.
 *
 * The Studio guide's key carries extra flags, because there the advice *within* one step changes without the step
 * moving — a board with cards parked by an agent is a different situation from one without, on the same step. Here
 * no fact works that way: every one of them decides a step, so the first unfinished step already says everything
 * there is to say about where the project is. Anything else in the key would be churn — counting the uncommitted
 * files, for instance, would buy a fresh explanation every time a file is saved while the advice stayed identical.
 */
export function codeGuideStateKey(steps: readonly CodeGuideStep[]): string {
  const current = steps.find((step) => step.state === 'current' || step.state === 'blocked');
  return current?.id ?? 'none';
}

export function emptyCodeGuide(): CodeGuide {
  return createCodeGuide();
}

/**
 * The one prompt this guide sends.
 *
 * Beyond the same "the steps are decided, do not re-decide them" instruction the Studio guide carries, this one
 * has a second job: staying out of the Learn panel's way. That panel already answers "what shall I practise next,
 * in this file" from its own rules, and a second voice answering the same question in different words is how two
 * halves of one screen start contradicting each other. So the model is told its subject is the project as a whole
 * and the single project-level action, and that naming a file or a concept to go and study is not its job.
 */
export function codeGuideNarrativePrompt(
  facts: CodeGuideFacts,
  steps: readonly CodeGuideStep[],
  history: readonly { title: string }[],
  project: CodeProjectBreakdown,
): { system: string; user: string } {
  const system = [
    'You are an experienced developer sitting beside someone who is learning, in a tool called KAI.',
    'They are typing code by hand, so they are the one doing the work and you are the one telling them where they are.',
    'You are given the project\'s current step, decided in advance. Explain it; do not re-decide it, do not suggest a',
    'different order, and never tell them to do two things at once. Name the one next action, and say what it will do',
    'and roughly what happens after it.',
    '',
    'Speak only about the project as a whole. Another panel already tells them which file or concept to study next,',
    'so do not tell them to open, read or practise a particular file or concept — stay above that level.',
    'You may say what the project is made of and what it is written in, since that is the whole project rather than any',
    'one file in it.',
    'If the project has no version control, or no board, do not talk about them as though it did.',
    '',
    'Write for a beginner: short sentences, no jargon without a plain gloss, no praise, no filler. Two or three',
    'paragraphs at most. If something is stuck, say what it is stuck on and that it is not their mistake.',
    '',
    'Reply with JSON only: {"headline": "...", "explanation": "..."}. The headline is one short line naming where they',
    'are. The explanation is the walkthrough.',
  ].join(' ');
  const user = [
    `STEPS (already decided, in order):\n${steps.map((step) => `- [${step.state}] ${step.title} — ${step.detail}`).join('\n')}`,
    '',
    `WHAT HAS BEEN DONE SO FAR:\n${history.length > 0 ? history.map((entry) => `- ${entry.title}`).join('\n') : '- Nothing yet.'}`,
    '',
    'THE REPOSITORY:',
    facts.git.isRepository
      ? `${plural(facts.git.commits, 'commit')}${facts.git.branch ? ` on ${facts.git.branch}` : ''}, ${plural(facts.git.changed, 'uncommitted file')}${
          facts.git.ahead > 0 ? `, ${plural(facts.git.ahead, 'commit')} not pushed` : ''
        }${facts.git.behind > 0 ? `, ${plural(facts.git.behind, 'commit')} not pulled` : ''}.`
      : 'This folder is not a Git repository.',
    '',
    `THE CODE: ${plural(facts.files.total, 'file')}, ${plural(facts.files.tests, 'test file')}.`,
    project.languages.length > 0
      ? `WRITTEN IN: ${project.languages.map((entry) => `${entry.label} (${entry.files} files)`).join(', ')}.`
      : '',
    project.areas.length > 0
      ? `MADE OF:\n${project.areas.map((area) => `- ${area.path}: ${plural(area.files, 'file')}${area.tests > 0 ? `, ${plural(area.tests, 'test file')}` : ''}`).join('\n')}`
      : '',
    `WHAT THEY HAVE STUDIED: ${facts.learn.concepts === 0 ? 'nothing yet' : `${plural(facts.learn.concepts, 'concept')}`}${
      facts.learn.recommendedNext ? `; the Learn panel suggests: ${facts.learn.recommendedNext}` : ''
    }.`,
    // Only mentioned when there is one, so the model is never invited to describe an empty board as progress.
    facts.board.total > 0
      ? `THE BOARD: ${facts.board.total} cards — ${facts.board.done} done, ${facts.board.ready} ready, ${facts.board.inProgress} in progress, ${facts.board.review} in review, ${facts.board.blocked} blocked.`
      : 'THE BOARD: this project has no cards.',
    '',
    'Write the headline and the explanation.',
  ].join('\n');
  return { system, user };
}
