import { describe, expect, it } from 'vitest';
import { createCodeGuide, type ProjectFileEntry } from '../packages/contracts/src';
import { guideView } from '../apps/desktop/src/main/guide-core';
import {
  codeGuideNarrativePrompt,
  codeGuideStateKey,
  codeGuideSteps,
  codeProjectBreakdown,
  type CodeGuideFacts,
} from '../apps/desktop/src/main/code-guide';

/**
 * A folder with nothing in it — no repository, no files, no history — which is where most projects start and the
 * case the guide has to get right first. Each test states only the thing it is about on top of this.
 */
function facts(over: Partial<CodeGuideFacts> = {}): CodeGuideFacts {
  return {
    git: { isRepository: false, branch: null, commits: 0, latest: '', changed: 0, ahead: 0, behind: 0 },
    files: { total: 0, tests: 0, firstTest: null },
    learn: { concepts: 0, weakest: null, recommendedNext: '' },
    board: { total: 0, done: 0, ready: 0, inProgress: 0, review: 0, blocked: 0, nextCard: null },
    ...over,
  };
}

/**
 * A project that has everything but the step a test is about, so a late step does not have to restate the early
 * ones. Everything here is in order: repository, commits, a clean tree, studied concepts, tests.
 */
function working(over: Partial<CodeGuideFacts> = {}): CodeGuideFacts {
  return facts({
    git: { isRepository: true, branch: 'main', commits: 3, latest: 'Add the booking form', changed: 0, ahead: 0, behind: 0 },
    files: { total: 12, tests: 2, firstTest: 'test/booking.test.ts' },
    learn: { concepts: 4, weakest: 'closures', recommendedNext: 'Practise closures' },
    ...over,
  });
}

const entry = (path: string): ProjectFileEntry => ({ path, size: 1 });

/**
 * A project with a shape worth reading: code in `src` (including a nested folder), tests in their own folder, and two
 * files at the root. Deliberately small — the counting is the thing under test, not the walk.
 */
const tree: ProjectFileEntry[] = [
  entry('src/index.ts'),
  entry('src/app.ts'),
  entry('src/api/routes.ts'),
  entry('src/styles.css'),
  entry('test/app.test.ts'),
  entry('test/routes.test.ts'),
  entry('README.md'),
  entry('package.json'),
];

const idOf = (steps: ReturnType<typeof codeGuideSteps>): string | undefined =>
  steps.find((step) => step.state === 'current' || step.state === 'blocked')?.id;

const stepOf = (steps: ReturnType<typeof codeGuideSteps>, id: string) => steps.find((step) => step.id === id);

describe('the code guide decides by rules', () => {
  it('starts an empty folder at the one step that has something to press', () => {
    const steps = codeGuideSteps(facts());

    expect(idOf(steps)).toBe('versioned');
    expect(stepOf(steps, 'versioned')?.action).toBe('init-git');
    // Nothing here is waiting on someone else, so no step claims to be blocked; a guide that called every
    // unfinished step "needs you" would be saying nothing at all.
    expect(steps.some((step) => step.state === 'blocked')).toBe(false);
  });

  it('stops offering to start version control once the folder is a repository', () => {
    const steps = codeGuideSteps(facts({ git: { ...facts().git, isRepository: true } }));

    expect(idOf(steps)).toBe('committed');
    expect(stepOf(steps, 'versioned')?.action).toBeNull();
    expect(stepOf(steps, 'versioned')?.actionLabel).toBeNull();
  });

  it('leaves out the board step entirely for a project with no cards', () => {
    const steps = codeGuideSteps(working());

    expect(stepOf(steps, 'board')).toBeUndefined();
    // A project with no board still reaches the end, which is the point of building the last step after the filter.
    expect(steps.every((step) => step.state === 'done')).toBe(true);
    expect(steps[steps.length - 1]?.id).toBe('ready');
  });

  it('shows the board step, and where the project is on it, once there are cards', () => {
    const steps = codeGuideSteps(working({
      board: { total: 4, done: 1, ready: 2, inProgress: 1, review: 0, blocked: 0, nextCard: 'Add the sign-up form' },
    }));

    expect(idOf(steps)).toBe('board');
    expect(stepOf(steps, 'board')?.detail).toContain('1 of 4 cards done');
    expect(stepOf(steps, 'board')?.detail).toContain('Add the sign-up form');
  });

  it('walks forward as each fact lands', () => {
    const repoOnly = facts({ git: { ...facts().git, isRepository: true } });
    expect(idOf(codeGuideSteps(repoOnly))).toBe('committed');

    const committed = facts({ git: { ...facts().git, isRepository: true, commits: 1, latest: 'First commit' } });
    expect(idOf(codeGuideSteps(committed))).toBe('understood');

    const studied = working({ files: { total: 12, tests: 0, firstTest: null } });
    expect(idOf(codeGuideSteps(studied))).toBe('tested');

    const withTests = working({ git: { ...working().git, changed: 2 } });
    expect(idOf(codeGuideSteps(withTests))).toBe('clean');

    expect(idOf(codeGuideSteps(working()))).toBeUndefined();
  });

  it('is finished only when the board is finished too', () => {
    const unfinished = codeGuideSteps(working({
      board: { total: 4, done: 3, ready: 1, inProgress: 0, review: 0, blocked: 0, nextCard: 'Wire the emails' },
    }));

    expect(idOf(unfinished)).toBe('board');
    expect(unfinished.some((step) => step.state === 'done' && step.id === 'ready')).toBe(false);
  });

  it('carries the dirty tree as work in progress without dragging the earlier steps back', () => {
    const steps = codeGuideSteps(working({ git: { ...working().git, changed: 2 } }));

    expect(idOf(steps)).toBe('clean');
    // Everything the project already passed stays passed: a step that un-does itself would un-do the history too.
    expect(['versioned', 'committed', 'understood', 'tested'].map((id) => stepOf(steps, id)?.state))
      .toEqual(['done', 'done', 'done', 'done']);
  });

  it('says what is actually waiting once nothing on the ladder is', () => {
    const steps = codeGuideSteps(working());
    expect(stepOf(steps, 'ready')?.detail).toContain('Practise closures');
  });

  it('reports a finished project as standing on its last step', () => {
    const finished = working();
    const steps = codeGuideSteps(finished);

    // A project that has passed everything has no `current` step, so the view falls back to the last one — which is
    // what makes a finished project read as "Everything is in order" rather than as a screen with nothing on it.
    const view = guideView(createCodeGuide(), steps, codeGuideStateKey(steps));

    expect(view.currentStepId).toBe('ready');
    expect(view.narrative).toBeNull();
  });
});

describe('the explanation is only rewritten when the situation changes', () => {
  it('holds still while only the size of the change moves', () => {
    const small = working({ git: { ...working().git, changed: 3 } });
    const large = working({ git: { ...working().git, changed: 40 } });

    expect(codeGuideStateKey(codeGuideSteps(large))).toBe(codeGuideStateKey(codeGuideSteps(small)));
  });

  it('changes when the project moves on to a different step', () => {
    const clean = working();
    const dirty = working({ git: { ...working().git, changed: 1 } });

    expect(codeGuideStateKey(codeGuideSteps(dirty))).not.toBe(codeGuideStateKey(codeGuideSteps(clean)));
  });
});

describe('the project breakdown', () => {
  it('groups files by their top-level directory, biggest first', () => {
    const breakdown = codeProjectBreakdown(tree);

    expect(breakdown.files).toBe(8);
    // `src` has the most files; the two with two each are separated by name, which is what keeps the list stable.
    expect(breakdown.areas).toEqual([
      { path: 'src', files: 4, tests: 0 },
      { path: '.', files: 2, tests: 0 },
      { path: 'test', files: 2, tests: 2 },
    ]);
  });

  it('names the languages it can, and stays in the same order between reads', () => {
    // Equal counts, so the name decides. Without that the order would follow whichever file the walk reached first,
    // and the panel would reshuffle itself every time it was redrawn.
    expect(codeProjectBreakdown(tree).languages).toEqual([
      { label: 'TypeScript', files: 5 },
      { label: 'CSS', files: 1 },
      { label: 'JSON', files: 1 },
      { label: 'Markdown', files: 1 },
    ]);
  });

  it('describes an empty folder without pretending it has a shape', () => {
    expect(codeProjectBreakdown([])).toEqual({ files: 0, areas: [], languages: [] });
  });

  it('does not read a dot in a directory name as a file extension', () => {
    const breakdown = codeProjectBreakdown([entry('v1.2/index'), entry('src/main.rs')]);

    // Only the Rust file gets a language; the extension-less one is still counted and still placed in its area.
    expect(breakdown.languages).toEqual([{ label: 'Rust', files: 1 }]);
    expect(breakdown.files).toBe(2);
    expect(breakdown.areas.map((area) => area.path)).toEqual(['src', 'v1.2']);
  });

  it('caps the picture rather than listing every directory', () => {
    const many = Array.from({ length: 20 }, (_, index) => entry(`dir${String(index).padStart(2, '0')}/file.ts`));

    expect(codeProjectBreakdown(many).areas).toHaveLength(12);
  });
});

describe('the code guide prompt', () => {
  const steps = codeGuideSteps(working());
  const prompt = codeGuideNarrativePrompt(working(), steps, [], codeProjectBreakdown(tree));

  it('gives the model the steps already decided and tells it not to re-decide them', () => {
    expect(prompt.user).toContain('Put the project under version control');
    expect(prompt.system).toContain('do not re-decide it');
  });

  it('keeps the model out of the Learn panel’s business', () => {
    // Two voices answering "what shall I practise next" is how one screen starts contradicting itself.
    expect(prompt.system).toContain('do not tell them to open, read or practise a particular file or concept');
  });

  it('carries the project’s shape, so the walkthrough can describe it', () => {
    expect(prompt.user).toContain('WRITTEN IN: TypeScript (5 files)');
    expect(prompt.user).toContain('MADE OF:');
    expect(prompt.user).toContain('- src: 4 files');
    expect(prompt.user).toContain('- test: 2 files, 2 test files');
    // The whole project is the model's to describe; a single file in it still is not.
    expect(prompt.system).toContain('You may say what the project is made of');
  });

  it('does not let the model talk about a repository or a board the project does not have', () => {
    const bare = facts();
    const barePrompt = codeGuideNarrativePrompt(bare, codeGuideSteps(bare), [], codeProjectBreakdown([]));

    expect(barePrompt.user).toContain('not a Git repository');
    expect(barePrompt.user).toContain('this project has no cards');
  });
});
