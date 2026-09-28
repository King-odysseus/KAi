import { describe, expect, it } from 'vitest';
import { createDefaultAgentTeam, createDefaultSettings, partsFromGuide, promptGuideSettingsSchema, type AgentTeam } from '../packages/contracts/src';
import type { ProviderConnection } from '../apps/desktop/src/main/learning-tutor';
import {
  DesktopPromptGuide,
  buildPromptGuidePrompt,
  buildPromptRefinementPrompt,
  parsePromptGuideContent,
  parsePromptRefinementContent,
  type PromptGuidePorts,
} from '../apps/desktop/src/main/prompt-guide';

const team: AgentTeam = {
  ...createDefaultAgentTeam(),
  custom: [{ id: 'custom-database', label: 'Database specialist', description: 'Schema and migrations.', access: 'edit', assignee: 'auto', route: 'auto', instructions: '' }],
};

function ports(overrides: Partial<PromptGuidePorts> = {}, guide: Partial<ReturnType<typeof promptGuideSettingsSchema.parse>> = {}): PromptGuidePorts {
  const settings = createDefaultSettings();
  return {
    settings: () => Promise.resolve({ ...settings, promptGuide: { ...settings.promptGuide, enabled: true, ...guide } }),
    team: () => Promise.resolve(team),
    projectRoot: () => Promise.resolve(process.cwd()),
    credentialStored: () => Promise.resolve(true),
    vaultAvailable: () => true,
    requester: { structuredRequest: () => Promise.reject(new Error('not called')) },
    ...overrides,
  };
}

describe('Prompt Guide', () => {
  it('is off by default, and says what to do before it can run', async () => {
    expect(createDefaultSettings().promptGuide.enabled).toBe(false);
    const off = new DesktopPromptGuide(ports({}, { enabled: false }));
    expect((await off.readiness()).reason).toMatch(/Turn it on/);
    const noKey = new DesktopPromptGuide(ports({ credentialStored: () => Promise.resolve(false) }));
    expect((await noKey.readiness()).reason).toMatch(/Save the provider.openai key/);
    expect((await new DesktopPromptGuide(ports()).readiness()).ready).toBe(true);
  });

  it('lists the team roles, custom ones included, and passes on answered questions only', () => {
    const prompt = buildPromptGuidePrompt({
      projectId: 'p1',
      idea: 'a way to share recipes',
      answers: [{ question: 'Public or private?', answer: 'Private' }, { question: 'Photos?', answer: '  ' }],
    }, team, 'File: src/app.ts');
    expect(prompt.system).toContain('"frontend"');
    expect(prompt.system).toContain('"custom-database"');
    expect(prompt.system).not.toContain('"orchestrator"');
    expect(prompt.user).toContain('Q: Public or private?\nA: Private');
    expect(prompt.user).not.toContain('Photos?');
    expect(prompt.user).toContain('File: src/app.ts');
  });

  it('keeps prompts for real roles and drops any role the team does not have', () => {
    const result = parsePromptGuideContent(JSON.stringify({
      goal: 'Let signed-in users save private recipes.',
      assumptions: ['Web only'],
      questions: [],
      prompts: [
        { role: 'backend', title: 'Recipe API', prompt: 'Add CRUD endpoints.', paths: ['src/api/'] },
        { role: 'custom-database', title: 'Recipes table', prompt: 'Add a migration.', paths: [] },
        { role: 'orchestrator', title: 'Plan', prompt: 'Plan it.', paths: [] },
        { role: 'designer', title: 'Mockups', prompt: 'Draw it.', paths: [] },
      ],
    }), team);
    expect(result.prompts.map((item) => item.role)).toEqual(['backend', 'custom-database']);
  });

  it('fails clearly when no usable prompt is left', () => {
    expect(() => parsePromptGuideContent(JSON.stringify({ goal: 'x', assumptions: [], questions: [], prompts: [{ role: 'designer', title: 'a', prompt: 'b', paths: [] }] }), team))
      .toThrow(/did not match the expected shape/);
  });

  it('turns prompts into plan parts, with tests waiting for the parts that edit files', () => {
    const parts = partsFromGuide([
      { role: 'frontend', title: 'Recipe page', prompt: 'Build the page.', paths: [] },
      { role: 'backend', title: 'Recipe API', prompt: 'Add endpoints.', paths: [] },
      { role: 'tests', title: 'Tests', prompt: 'Test both.', paths: [] },
      { role: 'backend', title: 'Recipe API', prompt: 'Add search.', paths: [] },
    ], team);
    expect(parts.map((part) => part.id)).toEqual(['recipe-page', 'recipe-api', 'tests', 'recipe-api-2']);
    expect(parts[2]?.dependsOn).toEqual(['recipe-page', 'recipe-api', 'recipe-api-2']);
  });

  it('rewrites a draft for the selected composer intent without adding scope', () => {
    const prompt = buildPromptRefinementPrompt({ text: 'fix login', intent: 'build' });
    expect(prompt.system).toContain('desired change explicit');
    expect(prompt.system).toContain('Do not add requirements or invent decisions');
    expect(prompt.user).toBe('Draft:\nfix login');
  });

  it('accepts only a non-empty refined prompt', () => {
    expect(parsePromptRefinementContent(JSON.stringify({ prompt: 'Fix the login redirect and verify it.' })).prompt)
      .toBe('Fix the login redirect and verify it.');
    expect(() => parsePromptRefinementContent(JSON.stringify({ prompt: '' }))).toThrow(/did not match the expected shape/);
  });

  it('falls back to Direct API when the Prompt Guide connection is off', async () => {
    const settings = createDefaultSettings();
    const used: ProviderConnection[] = [];
    const guide = new DesktopPromptGuide(ports({
      settings: () => Promise.resolve({
        ...settings,
        promptGuide: { ...settings.promptGuide, enabled: false },
        directApi: { ...settings.directApi, enabled: true, provider: 'deepseek', model: 'deepseek-chat', credentialId: 'provider.deepseek' },
      }),
      requester: {
        structuredRequest: async (connection, _names, _prompt, _schemaName, _schema, parse) => {
          used.push(connection);
          return parse(JSON.stringify({ prompt: 'Fix the login redirect and verify it.' }));
        },
      },
    }));

    await expect(guide.refinePrompt({ text: 'fix login', intent: 'build' }))
      .resolves.toEqual({ prompt: 'Fix the login redirect and verify it.' });
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
