import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  boardCardSchema,
  createStudioBoard,
  gitOverviewSchema,
  learningProgressSchema,
  type BoardCard,
  type GitChange,
  type GitCommitSummary,
  type GitOverview,
  type LearningProgress,
  type ProjectFileEntry,
  type StudioBoard,
} from '../packages/contracts/src';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { CODE_GUIDE_PATH } from '../apps/desktop/src/main/code-guide';
import { DesktopCodeGuideService, type CodeGuidePorts } from '../apps/desktop/src/main/code-guide-service';

const NOW = '2026-10-04T12:00:00.000Z';
let root = '';

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-code-guide-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function card(over: Partial<BoardCard> = {}): BoardCard {
  return boardCardSchema.parse({ id: 'c1', title: 'Sign up', kind: 'backend', createdAt: NOW, updatedAt: NOW, ...over });
}

function commit(subject = 'First commit'): GitCommitSummary {
  return { hash: 'abc1234', subject, author: 'Nate', date: NOW };
}

function change(filePath: string): GitChange {
  return { path: filePath, index: 'M', worktree: 'M', staged: false, unstaged: true };
}

function overview(over: Partial<GitOverview> = {}): GitOverview {
  return gitOverviewSchema.parse({
    isRepository: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0,
    remotes: [], githubRepository: null, branches: [], changes: [], commits: [],
    github: { cliAvailable: false, signedInAs: null }, pullRequests: [],
    ...over,
  });
}

function progress(over: Partial<LearningProgress> = {}): LearningProgress {
  return learningProgressSchema.parse({
    schemaVersion: 1,
    projectId: 'p1',
    preferences: { assistance: 'guided', inlineSuggestions: false },
    concepts: [],
    recentEvidence: [],
    memory: { lessonId: 'l1', lastLesson: '', unresolvedCheck: '', recommendedNext: '', understood: false },
    updatedAt: NOW,
    ...over,
  });
}

function concept(over: Record<string, unknown> = {}) {
  return {
    id: 'c1', name: 'closures', category: 'language', mastery: 'developing', score: 40,
    evidenceCount: 1, evidence: ['Explained a closure.'], strengths: [], nextStep: 'Practise closures',
    firstSeenAt: NOW, lastSeenAt: NOW, ...over,
  };
}

const file = (filePath: string): ProjectFileEntry => ({ path: filePath, size: 120 });

/**
 * A project the guide can read, with every source standing in. The git overview is returned by reference so a test
 * can move the working tree the way the studio guide's tests move cards.
 */
function harness(options: {
  git?: Partial<GitOverview>;
  files?: ProjectFileEntry[];
  learn?: Partial<LearningProgress>;
  cards?: BoardCard[];
  fail?: Array<'git' | 'files' | 'learn' | 'board'>;
} = {}) {
  let calls = 0;
  const git = overview(options.git ?? {});
  const board: StudioBoard = { ...createStudioBoard(), cards: options.cards ?? [] };
  const broken = new Set(options.fail ?? []);
  const gone = async (): Promise<never> => { throw new Error('The folder is no longer there.'); };
  const ports: CodeGuidePorts = {
    settings: async () => ({ promptGuide: {} }) as never,
    requester: {
      structuredRequest: async (_connection, _names, _prompt, _schemaName, _schema, parse) => {
        calls += 1;
        return parse(JSON.stringify({ headline: 'Where you are', explanation: `Explanation ${calls}.` }));
      },
    },
    spec: new SpecStore(),
    projectRoot: async () => root,
    git: broken.has('git') ? gone : async () => git,
    files: broken.has('files') ? gone : async () => options.files ?? [],
    learn: broken.has('learn') ? gone : async () => progress(options.learn ?? {}),
    board: broken.has('board') ? gone : async () => board,
    now: () => NOW,
  };
  return { service: new DesktopCodeGuideService(ports), board, git, calls: () => calls, root };
}

const storedGuide = (): { history: Array<{ stepId: string }> } =>
  JSON.parse(fs.readFileSync(path.join(root, '.kai', 'spec', CODE_GUIDE_PATH), 'utf8'));

describe('the Code guide service', () => {
  it('reads the steps without calling the provider, so the strip above the editor stays free', async () => {
    const h = harness();

    const view = await h.service.read('p1');

    expect(h.calls()).toBe(0);
    expect(view.currentStepId).toBe('versioned');
    expect(view.narrative).toBeNull();
  });

  it('pays for the explanation once per situation, not once per look', async () => {
    const h = harness({ git: { isRepository: true, branch: 'main', commits: [commit()] } });

    await h.service.explain('p1');
    await h.service.explain('p1');

    expect(h.calls()).toBe(1);
  });

  it('does not rewrite the explanation while only the amount of change moves', async () => {
    const h = harness({ git: { isRepository: true, branch: 'main', commits: [commit()] } });
    await h.service.explain('p1');

    h.git.changes = [change('a.ts')];
    const after = await h.service.explain('p1');

    expect(h.calls()).toBe(1);
    // The words are kept, and the step detail beside them is still live — the stored text is returned as written.
    expect(after.narrative?.explanation).toBe('Explanation 1.');
    expect(after.steps.find((step) => step.id === 'clean')?.detail).toContain('1 file changed');
  });

  it('writes what it has seen to its own file, and reads it back', async () => {
    const h = harness({ git: { isRepository: true, branch: 'main', commits: [commit()] } });

    await h.service.read('p1');

    expect(storedGuide().history.map((entry) => entry.stepId)).toEqual(['versioned', 'committed']);
    // A fresh service on the same folder starts from what was recorded rather than from nothing.
    const second = await harness({ git: { isRepository: true, branch: 'main', commits: [commit()] } }).service.read('p1');
    expect(second.history.map((entry) => entry.stepId)).toEqual(['versioned', 'committed']);
  });

  it('never writes the studio guide’s file', async () => {
    const h = harness({ git: { isRepository: true, commits: [commit()] } });

    await h.service.read('p1');

    expect(fs.existsSync(path.join(root, '.kai', 'spec', 'guide.json'))).toBe(false);
  });

  it('still answers for a folder with no repository and no spec', async () => {
    const view = await harness().service.read('p1');

    expect(view.currentStepId).toBe('versioned');
    expect(view.steps.find((step) => step.id === 'versioned')?.action).toBe('init-git');
  });

  it('degrades to empty when a source fails, rather than failing the whole read', async () => {
    // This is the failure that left the studio guide's tab spinning forever: one broken source took the read with it.
    const h = harness({ fail: ['git', 'files', 'learn', 'board'] });

    const view = await h.service.read('p1');

    expect(view.currentStepId).toBe('versioned');
    expect(view.steps.find((step) => step.id === 'board')).toBeUndefined();
  });

  it('names the shakiest concept and leaves the mastered ones out of it', async () => {
    const h = harness({
      learn: {
        concepts: [
          concept({ id: 'a', name: 'closures', mastery: 'developing', score: 40 }),
          // Lower-scoring but already independent, so it is not the one to call out.
          concept({ id: 'b', name: 'loops', mastery: 'independent', score: 5 }),
        ],
      },
    });

    const view = await h.service.read('p1');

    expect(view.steps.find((step) => step.id === 'understood')?.detail).toContain('closures');
    expect(view.steps.find((step) => step.id === 'understood')?.detail).not.toContain('loops');
  });

  it('counts test files by the conventions projects actually use', async () => {
    const h = harness({
      files: [
        file('src/index.ts'),
        file('src/booking.test.ts'),
        file('test/checkout.spec.ts'),
        file('tests/helpers.py'),
        file('src/latest.ts'),
      ],
    });

    const view = await h.service.read('p1');

    expect(view.steps.find((step) => step.id === 'tested')?.detail).toContain('3 test files');
  });

  it('reads the board when the project has one', async () => {
    const h = harness({ cards: [card({ id: 'a', title: 'Wire the emails', status: 'ready' }), card({ id: 'b', status: 'done' })] });

    const view = await h.service.read('p1');

    expect(view.steps.find((step) => step.id === 'board')?.detail).toContain('Wire the emails');
  });
});
