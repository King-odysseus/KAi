import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyExecutionRulesToPrompt,
  applyExecutionRulesToRequest,
  AUTOPILOT_EXCEPTION,
  buildExecutionRulesBriefing,
  DesktopExecutionRules,
  INJECTED_RULES_PATH,
  injectRulesIntoProjects,
  RULES_MARKER,
  shouldCarryRules,
  SINGLE_STYLESHEET_RULE,
  withAutopilotException,
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

/**
 * The fail-safe copy that sits in the project folder, for the runs the briefing does not reach.
 *
 * Worth pinning because nothing else notices it: a file written under the wrong name, or one that stops carrying the
 * marker, would leave every project quietly unprotected and the button would still report success.
 */
describe('the single stylesheet rule', () => {
  it('reaches every briefing, inside the markers, and is plain ASCII', () => {
    const briefing = buildExecutionRulesBriefing('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n');

    expect(briefing).toContain(SINGLE_STYLESHEET_RULE);
    expect(briefing.indexOf(SINGLE_STYLESHEET_RULE)).toBeLessThan(briefing.indexOf('[/COGNITIVE1 STANDING INSTRUCTIONS]'));
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(SINGLE_STYLESHEET_RULE)).toBe(true);
  });

  it('names Flowbite for a React project, and keeps HeroUI only where the project already uses it', () => {
    // The component library is the person's choice, and it is written down here so a new React project does not arrive
    // with hand-written components beside a Tailwind setup.
    expect(SINGLE_STYLESHEET_RULE).toContain('Flowbite');
    expect(SINGLE_STYLESHEET_RULE).toContain('Tailwind');
    expect(SINGLE_STYLESHEET_RULE).toContain('use HeroUI only where the project already uses it');
  });
});

describe('the Autopilot exception to committing', () => {
  it('goes inside the authoritative text, after the rules, so the rule set that wins is the one that carries it', async () => {
    const rules = await new DesktopExecutionRules(bundledRulesPath).read();
    const forAutopilot = withAutopilotException(rules);

    expect(forAutopilot.startsWith(rules)).toBe(true);
    expect(forAutopilot.trimEnd().endsWith(AUTOPILOT_EXCEPTION)).toBe(true);
    // And it reaches the agent through the same briefing every other run gets, between the same markers.
    const briefing = buildExecutionRulesBriefing(forAutopilot);
    expect(briefing).toContain('do not run git add, git commit, git push or git tag');
    expect(briefing.indexOf('## Exception for Autopilot runs')).toBeGreaterThan(briefing.indexOf('## Commit & Push'));
    expect(briefing.startsWith(RULES_MARKER)).toBe(true);
  });

  it('is plain ASCII, like the rules it amends, which forbid dashes and decoration', () => {
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(AUTOPILOT_EXCEPTION)).toBe(true);
  });

  it('leaves an ordinary run, which keeps the commit rule, untouched', async () => {
    const rules = await new DesktopExecutionRules(bundledRulesPath).read();
    expect(buildExecutionRulesBriefing(rules)).not.toContain('Exception for Autopilot runs');
  });
});

describe('injecting the standing rules into projects', () => {
  it('writes the rules into each project under the name the context builder reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-rules-inject-'));
    const project = path.join(root, 'alpha');
    await fs.mkdir(project, { recursive: true });

    const [result] = await injectRulesIntoProjects('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n', 'C:/rules/Instruct.md', [
      { name: 'alpha', path: project },
    ]);

    expect(result?.status).toBe('written');
    const written = await fs.readFile(path.join(project, INJECTED_RULES_PATH), 'utf8');
    expect(INJECTED_RULES_PATH).toBe('.kai/instructions.md');
    expect(written).toContain(RULES_MARKER);
    expect(written).toContain('Never commit keys.');
    expect(written).toContain('C:/rules/Instruct.md');

    // Second press is a no-op rather than a rewrite, so pressing it does not churn every open repository.
    const [again] = await injectRulesIntoProjects('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n', 'C:/rules/Instruct.md', [
      { name: 'alpha', path: project },
    ]);
    expect(again?.status).toBe('unchanged');
  });

  it('reports a project it cannot write instead of failing the whole press', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-rules-inject-'));
    const good = path.join(root, 'good');
    await fs.mkdir(good, { recursive: true });

    const results = await injectRulesIntoProjects('# Cognitive1\n\n## Rules\n\n1. **No secrets** - Never commit keys.\n', 'C:/rules/Instruct.md', [
      { name: 'gone', path: path.join(root, 'does-not-exist') },
      { name: 'good', path: good },
    ]);

    const gone = results.find((result) => result.name === 'gone');
    const written = results.find((result) => result.name === 'good');
    // A project that has been moved or deleted since KAI last listed it is reported rather than recreated: writing
    // into it would leave a resurrected folder holding nothing but this one file.
    expect(gone?.status).toBe('failed');
    expect(gone?.message).toBe('The project folder is no longer there.');
    await expect(fs.stat(path.join(root, 'does-not-exist'))).rejects.toThrow();
    expect(written?.status).toBe('written');
  });
});

/**
 * Who carries the rules into a run.
 *
 * The API path used to carry them twice on every turn — once in the context block and once in front of the request —
 * because the check that was meant to notice they were already there could never see them. Eighteen kilobytes, twice,
 * on the path most runs take.
 */
describe('who carries the standing rules', () => {
  it('has a fresh CLI session carry them, and a continued one not', () => {
    expect(shouldCarryRules({ execution: 'cli', rulesInContext: false, historyCarriesRules: false })).toBe(true);
    expect(shouldCarryRules({ execution: 'cli', resumeSessionId: 'sess-1', rulesInContext: false, historyCarriesRules: false })).toBe(true);
  });

  it('leaves them to the context block on the API path, which always states them', () => {
    expect(shouldCarryRules({ execution: 'api', rulesInContext: true, historyCarriesRules: false })).toBe(false);
  });

  it('carries them itself when nothing else does', () => {
    // No context block with the rules — a project with nothing to put in one — so the request has to hold them.
    expect(shouldCarryRules({ execution: 'api', rulesInContext: false, historyCarriesRules: false })).toBe(true);
    // And a summarised history that still holds the turn which carried them is enough.
    expect(shouldCarryRules({ execution: 'api', rulesInContext: false, historyCarriesRules: true })).toBe(false);
  });

  it('does not trust history alone, because the turns saved never hold the briefed prompt', () => {
    // The trap: a conversation's turns keep the request as the person wrote it, so this flag is false in practice —
    // which is why the context block is what the decision turns on.
    const real = shouldCarryRules({ execution: 'api', rulesInContext: true, historyCarriesRules: false });
    expect(real).toBe(false);
  });
});
