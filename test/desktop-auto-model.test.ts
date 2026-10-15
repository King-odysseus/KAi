import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appSettingsV1Schema,
  classifyWork,
  createDefaultAgentTeam,
  createDefaultAutoModel,
  createDefaultSettings,
  learningTutorScopeSchema,
  tierModelFor,
  type TeamPart,
} from '../packages/contracts/src';
import { autoCliModel } from '../apps/desktop/src/main/auto-model';
import { assignTeam, partLevel, type AssignmentEnvironment } from '../apps/desktop/src/main/team-assign';
import { searchProjectContext, searchTerms } from '../apps/desktop/src/main/learning-tutor';

const ALL = ['claude', 'codex', 'qwen', 'gemini', 'kimi'] as const;

function environment(extra: Partial<AssignmentEnvironment> = {}): AssignmentEnvironment {
  return {
    capabilities: ALL.map((id): AssignmentEnvironment['capabilities'][number] => ({
      id, displayName: id, available: true, state: 'ready', supportsRoutes: ['direct', 'proxy'],
    })),
    api: { available: false, displayName: 'KAI API' },
    proxyReady: true,
    autoModel: createDefaultAutoModel(),
    ...extra,
  };
}

function part(overrides: Partial<TeamPart> = {}): TeamPart {
  return { id: 'ui', title: 'Button label', role: 'frontend', prompt: 'Change the label.', dependsOn: [], paths: [], ...overrides };
}

describe('classifyWork', () => {
  it('rates small, contained edits as light', () => {
    expect(classifyWork('fix the typo in the login button label').level).toBe('light');
    expect(classifyWork('rename fetchUser to loadUser').level).toBe('light');
  });

  it('rates design, cross-cutting work and hard bugs as heavy', () => {
    expect(classifyWork('refactor the auth flow across the whole app').level).toBe('heavy');
    expect(classifyWork('find the root cause of this race condition').level).toBe('heavy');
    expect(classifyWork('x'.repeat(2_000)).level).toBe('heavy');
    expect(classifyWork('update these', { fileCount: 8 }).level).toBe('heavy');
  });

  it('keeps a bare follow-up standard rather than dropping it to the light model', () => {
    expect(classifyWork('ok, do it').level).toBe('standard');
    expect(classifyWork('add a settings page for notifications').level).toBe('standard');
  });

  it('does not call a long request light just because it says small', () => {
    expect(classifyWork(`a small change: ${'please update the handler. '.repeat(20)}`).level).toBe('standard');
  });
});

describe('auto model settings', () => {
  it('is on by default with a model per level for each CLI, and older settings gain it', () => {
    const defaults = createDefaultSettings();
    expect(defaults.autoModel.enabled).toBe(true);
    expect(tierModelFor(defaults.autoModel, 'claude', 'light')).toBe('haiku');
    expect(tierModelFor(defaults.autoModel, 'claude', 'heavy')).toBe('opus');
    expect(tierModelFor(defaults.autoModel, 'kimi', 'heavy')).toBeUndefined();
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.autoModel;
    expect(appSettingsV1Schema.parse(legacy).autoModel.enabled).toBe(true);
  });

  it('returns nothing when switched off', () => {
    expect(tierModelFor({ ...createDefaultAutoModel(), enabled: false }, 'claude', 'heavy')).toBeUndefined();
  });
});

describe('autoCliModel', () => {
  const settings = { autoModel: createDefaultAutoModel() };

  it('picks a model from the prompt for a direct CLI run and says why', () => {
    const choice = autoCliModel({ agent: 'claude', route: 'direct', prompt: 'fix the typo in the header' }, settings);
    expect(choice?.model).toBe('haiku');
    expect(choice?.note).toMatch(/^light work/);
  });

  it('trusts a level the caller already judged', () => {
    expect(autoCliModel({ agent: 'codex', route: 'direct', prompt: 'x'.repeat(5_000), effort: 'light' }, settings)?.model).toBe('gpt-5.6-luna');
  });

  it('leaves proxy runs, disabled settings and agents without tiers alone', () => {
    expect(autoCliModel({ agent: 'claude', route: 'proxy', prompt: 'fix a typo' }, settings)).toBeUndefined();
    expect(autoCliModel({ agent: 'claude', route: 'direct', prompt: 'fix a typo' }, { autoModel: { ...settings.autoModel, enabled: false } })).toBeUndefined();
    expect(autoCliModel({ agent: 'kimi', route: 'direct', prompt: 'fix a typo' }, settings)).toBeUndefined();
  });
});

describe('team parts get a model for their level', () => {
  it('uses the orchestrator level and explains the choice', () => {
    const team = { ...createDefaultAgentTeam(), roles: { ...createDefaultAgentTeam().roles, frontend: { assignee: 'claude' as const, route: 'direct' as const, instructions: '' } } };
    const { assignments } = assignTeam([part({ effort: 'light' })], team, environment());
    expect(assignments[0]?.model).toBe('haiku');
    expect(assignments[0]?.reason).toContain('Light work, so it runs on haiku.');
  });

  it('lets a model pinned on the role win', () => {
    const team = { ...createDefaultAgentTeam(), roles: { ...createDefaultAgentTeam().roles, frontend: { assignee: 'claude' as const, route: 'direct' as const, model: 'claude-sonnet-5', instructions: '' } } };
    expect(assignTeam([part({ effort: 'heavy' })], team, environment()).assignments[0]?.model).toBe('claude-sonnet-5');
  });

  it('never runs a reviewer on the light model', () => {
    expect(partLevel(part({ role: 'codeReviewer', effort: 'light' }), 'read')).toBe('standard');
    expect(partLevel(part({ effort: 'light' }), 'edit')).toBe('light');
  });

  it('sets no model when auto model is off', () => {
    const team = { ...createDefaultAgentTeam(), roles: { ...createDefaultAgentTeam().roles, frontend: { assignee: 'claude' as const, route: 'direct' as const, instructions: '' } } };
    const off = environment({ autoModel: { ...createDefaultAutoModel(), enabled: false } });
    expect(assignTeam([part({ effort: 'heavy' })], team, off).assignments[0]?.model).toBeUndefined();
  });
});

describe('Learning Mode auto scope', () => {
  it('is a valid scope', () => {
    expect(learningTutorScopeSchema.parse('auto')).toBe('auto');
  });

  it('splits dotted names and paths into search words, skipping filler', () => {
    const terms = searchTerms('What will request.household hold, and which line in accounts/middleware.py decides that?');
    expect(terms).toEqual(expect.arrayContaining(['request', 'household', 'accounts', 'middleware']));
    expect(terms).not.toContain('which');
  });

  it('finds the file that answers a question outside the open file, with numbered lines', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-auto-scope-'));
    try {
      await fs.mkdir(path.join(root, 'accounts'));
      await fs.writeFile(path.join(root, 'settings.py'), 'MIDDLEWARE = []\n');
      await fs.writeFile(path.join(root, 'accounts', 'middleware.py'), 'class HouseholdMiddleware:\n    def __call__(self, request):\n        request.household = None\n');
      await fs.writeFile(path.join(root, 'unrelated.py'), 'print("hello")\n');
      const context = await searchProjectContext(root, 'what does request.household hold?', 'settings.py');
      expect(context).toContain('File: accounts/middleware.py');
      expect(context).toContain('3:         request.household = None');
      expect(context).not.toContain('File: unrelated.py');
      expect(context).not.toContain('File: settings.py');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
