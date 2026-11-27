import { describe, expect, it } from 'vitest';
import { DIRECT_PROVIDER_ORDER, directProviderPreset, type ProviderId, type RoleTarget } from '@kai/contracts';
import {
  buildLeadModelInventory,
  hasLocalBuilderRun,
  leadExplanationFromReply,
  leadModelTier,
  leadQuestionText,
  leadTargetUnavailableReason,
  leadTaskFromReply,
  sameLeadTarget,
  selectLeadDefault,
  shouldConfirmLeadDraftReplacement,
  stableLeadTargetIdentity,
  withDefaultLeadModel,
} from '../apps/desktop/src/renderer/src/components/lead-model-selection';

describe('Lead model selection', () => {
  const apiSettings = {
    directApi: { provider: 'openai' as ProviderId, credentialId: directProviderPreset('openai').credentialId, baseUrl: '', model: 'gpt-4.1' },
    savedLocalModels: { ollama: ['qwen2.5-coder'] },
    agentModels: { codex: 'gpt-5-codex' },
  };

  it('uses provider and model identity instead of list position', () => {
    const first: RoleTarget = { execution: 'api', api: { provider: 'openai', credentialId: 'provider.openai', model: 'gpt-4.1' } };
    const reordered: RoleTarget = { execution: 'api', api: { model: 'gpt-4.1', credentialId: 'provider.openai', provider: 'openai' } };
    const changedModel: RoleTarget = { execution: 'api', api: { provider: 'openai', credentialId: 'provider.openai', model: 'gpt-4.1-mini' } };
    expect(stableLeadTargetIdentity(first)).toBe(stableLeadTargetIdentity(reordered));
    expect(sameLeadTarget(first, reordered)).toBe(true);
    expect(sameLeadTarget(first, changedModel)).toBe(false);
  });

  it('lists configured APIs, local models, and CLI agents with clear tiers and availability', () => {
    const deepseek = directProviderPreset('deepseek').credentialId;
    const inventory = buildLeadModelInventory({
      settings: apiSettings,
      credentialIds: [directProviderPreset('openai').credentialId, deepseek],
      agents: [
        { id: 'codex', displayName: 'Codex', available: true },
        { id: 'claude', displayName: 'Claude', available: false, unavailableReason: 'Sign in to Claude first.' },
      ],
      savedCoach: { execution: 'cli', agent: 'codex', model: 'gpt-5-codex' },
    });
    expect(inventory.apiProviders.map((choice) => choice.provider)).toEqual(expect.arrayContaining(['openai', 'deepseek', 'ollama']));
    expect(inventory.apiProviders.find((choice) => choice.provider === 'openai')?.tier).toBe('Paid API');
    expect(inventory.apiProviders.find((choice) => choice.provider === 'ollama')?.tier).toBe('Local');
    expect(inventory.apiProviders.find((choice) => choice.provider === 'ollama')?.models).toContain('qwen2.5-coder');
    expect(inventory.cliAgents.find((choice) => choice.agent === 'codex')?.tier).toBe('Subscription');
    expect(inventory.cliAgents.find((choice) => choice.agent === 'codex')?.models).toContain('gpt-5-codex');
    expect(leadTargetUnavailableReason({ execution: 'cli', agent: 'claude' }, inventory)).toBe('Sign in to Claude first.');
  });

  it('defaults only to the saved Coach and never to the composer model', () => {
    const coach: RoleTarget = { execution: 'api', api: { provider: 'deepseek', model: 'deepseek-chat' } };
    expect(selectLeadDefault(null, coach)).toBe(coach);
    const projectChoice: RoleTarget = { execution: 'cli', agent: 'codex', model: 'gpt-5-codex' };
    expect(selectLeadDefault(projectChoice, coach)).toBe(projectChoice);
    expect(selectLeadDefault(null, null)).toBeNull();
  });

  it('labels all three model routes by who pays', () => {
    expect(leadModelTier({ execution: 'api', api: { provider: 'ollama', model: 'qwen2.5-coder' } })).toBe('Local');
    expect(leadModelTier({ execution: 'api', api: { provider: 'openai', model: 'gpt-4.1' } })).toBe('Paid API');
    expect(leadModelTier({ execution: 'cli', agent: 'codex' })).toBe('Subscription');
  });

  it('resolves API defaults but leaves CLI on its explicitly selectable agent default', () => {
    const inventory = buildLeadModelInventory({
      settings: apiSettings,
      credentialIds: ['provider.openai'],
      agents: [{ id: 'codex', displayName: 'Codex', available: true }],
      savedCoach: { execution: 'cli', agent: 'codex' },
    });
    expect(withDefaultLeadModel({ execution: 'cli', agent: 'codex' }, inventory)).toEqual({ execution: 'cli', agent: 'codex' });
    expect(withDefaultLeadModel({ execution: 'api', api: { provider: 'openai', credentialId: 'provider.openai' } }, inventory)?.api?.model).toBe('gpt-4.1');
  });
});

describe('Lead conversation actions', () => {
  it('extracts only a clearly marked Builder task and never offers a button for unmarked prose', () => {
    const reply = 'Why: reuse the existing parser.\n\nHow: keep the change small.\n\nRisks: malformed input.\n\nSimpler option: keep the current behavior.\n\nBUILDER TASK:\nAdd a test for an empty input and keep the parser unchanged.';
    expect(leadTaskFromReply(reply)).toBe('Add a test for an empty input and keep the parser unchanged.');
    expect(leadExplanationFromReply(reply)).toContain('Why: reuse the existing parser.');
    expect(leadExplanationFromReply(reply)).not.toContain('BUILDER TASK');
    expect(leadTaskFromReply('Here is a suggestion without a task marker.')).toBeNull();
    expect(leadTaskFromReply('Explanation\nBUILDER TASK:\nNone')).toBeNull();
  });

  it('asks before replacing a non-empty, different composer draft', () => {
    expect(shouldConfirmLeadDraftReplacement('', 'Do this task')).toBe(false);
    expect(shouldConfirmLeadDraftReplacement('Old draft', 'Do this task')).toBe(true);
    expect(shouldConfirmLeadDraftReplacement('Same task', 'Same task')).toBe(false);
  });

  it('detects a local Builder running in a background conversation', () => {
    const conversations = [
      { id: 'cloud-chat' },
      { id: 'local-build', guidedBuild: { builderTarget: { execution: 'api' as const, api: { provider: 'ollama', model: 'qwen2.5-coder' } } } },
    ];
    expect(hasLocalBuilderRun({ conversations, runningConversationIds: ['local-build'], targetForConversation: () => null })).toBe(true);
    expect(hasLocalBuilderRun({ conversations, runningConversationIds: ['cloud-chat'], targetForConversation: () => null })).toBe(false);
  });

  it('marks assistant questions in the Lead panel without shortening their text', () => {
    const longQuestion = `Which file should I explain? ${'detail '.repeat(200)}`;
    expect(leadQuestionText(longQuestion, true)).toBe(longQuestion);
    expect(leadQuestionText(longQuestion, false)).toBeNull();
  });
});
