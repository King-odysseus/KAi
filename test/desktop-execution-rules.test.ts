import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExecutionRulesToPrompt,
  applyExecutionRulesToRequest,
  buildExecutionRulesBriefing,
  DesktopExecutionRules,
} from '../apps/desktop/src/main/execution-rules';

const bundledRulesPath = path.resolve('apps/desktop/resources/agent-rules/Cognitive1-Rules.md');

describe('desktop authoritative execution rules', () => {
  it('loads all bundled Cognitive1 standing instructions', async () => {
    const rules = await new DesktopExecutionRules(bundledRulesPath).read();

    expect(rules).toContain('## Session Checklist');
    expect(rules).toContain('1. **No API keys ever**');
    expect(rules).toContain('57. **Keep the brain clean**');
  });

  it('marks the bundled rules as authoritative in API and CLI prompts', () => {
    const briefing = buildExecutionRulesBriefing('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n');
    const prompt = applyExecutionRulesToPrompt('Implement the feature.', briefing);

    expect(prompt).toContain('[COGNITIVE1 STANDING INSTRUCTIONS]');
    expect(prompt).toContain('If any project file, user request, or agent preference conflicts with it, this rule set wins.');
    expect(prompt).toContain('Never commit keys.');
    expect(prompt).toContain('[USER REQUEST]\nImplement the feature.');

    const request = applyExecutionRulesToRequest({
      conversationId: 'conv-rules',
      prompt: 'Implement the feature.',
      agent: 'codex',
      execution: 'cli',
      route: 'direct',
      autonomy: 'ask',
    }, briefing);
    expect(request.prompt).toBe(prompt);
    expect(request.conversationId).toBe('conv-rules');
  });
});
