import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExecutionRulesToPrompt,
  applyExecutionRulesToRequest,
  buildExecutionRulesBriefing,
  DesktopExecutionRules,
  RULES_MARKER,
} from '../apps/desktop/src/main/execution-rules';

const bundledRulesPath = path.resolve('apps/desktop/resources/agent-rules/Cognitive1-Rules.md');

describe('desktop authoritative execution rules', () => {
  it('loads all bundled Cognitive1 standing instructions', async () => {
    const rules = await new DesktopExecutionRules(bundledRulesPath).read();

    expect(rules).toContain('## Session Checklist');
    expect(rules).toContain('1. **No API keys ever**');
    expect(rules).toContain('57. **Keep the brain clean**');
  });

  it('wraps the briefing in the marker the run looks for, at both ends', () => {
    // The run decides whether to send the rules by asking whether the turns it is about to send already carry them,
    // which it does by looking for this marker. If the briefing stopped carrying it, every run would silently send the
    // rules again — or, worse, stop recognising them — so the contract is worth pinning rather than assuming.
    const briefing = buildExecutionRulesBriefing('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n');

    expect(briefing.startsWith(RULES_MARKER)).toBe(true);
    expect(briefing.endsWith('[/COGNITIVE1 STANDING INSTRUCTIONS]')).toBe(true);
    expect(briefing.split(RULES_MARKER)).toHaveLength(2);
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
