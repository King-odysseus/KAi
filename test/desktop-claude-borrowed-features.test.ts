import { describe, expect, it } from 'vitest';
import { DEFER_MIN_TOOLS, TOOL_SEARCH_NAME, deferExternalTools, rankTools, shouldDefer } from '../apps/desktop/src/main/deferred-tools';
import { filterDiagnostics, parseTscOutput } from '../apps/desktop/src/main/type-diagnostics';
import { applyVerdicts, buildVerifyPrompt, parseVerdicts } from '../apps/desktop/src/main/change-review';
import { commandPrefix, suggestPermissionRules } from '../apps/desktop/src/main/permission-suggestions';
import type { ExternalToolPort } from '../apps/desktop/src/main/project-tools';

const tool = (name: string, description = `${name} tool`): unknown => ({ type: 'function', name, description, parameters: { type: 'object', properties: {} } });
const bigSet = (): unknown[] => [
  tool('mcp_playwright_browser_click', 'Click an element on the page'),
  tool('mcp_playwright_browser_navigate', 'Open a URL in the browser'),
  ...Array.from({ length: DEFER_MIN_TOOLS }, (_, index) => tool(`mcp_misc_tool_${index}`, `Unrelated helper number ${index}`)),
];
const portOf = (definitions: unknown[]): ExternalToolPort => ({
  definitions: async () => definitions,
  policy: () => ({ decision: 'allow' }),
  execute: async (name) => ({ ok: true, output: { ran: name } }),
});

describe('deferred outside tools', () => {
  it('leaves a small tool set alone', async () => {
    const small = [tool('a'), tool('b')];
    expect(shouldDefer(small)).toBe(false);
    expect(await deferExternalTools(portOf(small))!.definitions()).toBe(small);
  });

  it('offers only tool_search for a large set, then adds matching tools to the same array', async () => {
    const port = deferExternalTools(portOf(bigSet()))!;
    const offered = (await port.definitions()) as Array<{ name: string }>;
    expect(offered.map((definition) => definition.name)).toEqual([TOOL_SEARCH_NAME]);
    expect(port.policy(TOOL_SEARCH_NAME, 'plan')).toEqual({ decision: 'allow' });

    const result = await port.execute(TOOL_SEARCH_NAME, { query: 'browser click' });
    expect(result?.ok).toBe(true);
    expect(offered.map((definition) => definition.name)).toContain('mcp_playwright_browser_click');
    // A later search for the same thing does not add it twice.
    await port.execute(TOOL_SEARCH_NAME, { query: 'browser click' });
    expect(offered.filter((definition) => definition.name === 'mcp_playwright_browser_click')).toHaveLength(1);
  });

  it('keeps one run\'s loaded tools out of another run', async () => {
    const shared = portOf(bigSet());
    const first = deferExternalTools(shared)!;
    const second = deferExternalTools(shared)!;
    const firstOffered = (await first.definitions()) as unknown[];
    const secondOffered = (await second.definitions()) as unknown[];
    await first.execute(TOOL_SEARCH_NAME, { query: 'navigate' });
    expect(firstOffered).toHaveLength(2);
    expect(secondOffered).toHaveLength(1);
  });

  it('supports select: for exact names and says when nothing matched', async () => {
    const catalog = bigSet().map((definition) => ({ name: (definition as { name: string }).name, description: '', definition }));
    expect(rankTools(catalog, 'select:mcp_misc_tool_3').map((entry) => entry.name)).toEqual(['mcp_misc_tool_3']);
    const port = deferExternalTools(portOf(bigSet()))!;
    await port.definitions();
    const none = await port.execute(TOOL_SEARCH_NAME, { query: 'zzzz' });
    expect(JSON.stringify(none?.output)).toMatch(/No outside tool matched/);
  });
});

describe('type diagnostics', () => {
  const output = [
    "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "  The expected type comes from property 'n'.",
    "C:\\proj\\src\\b.ts(3,1): error TS2304: Cannot find name 'x'.",
    'unrelated noise',
  ].join('\n');

  it('parses tsc output, folds continuation lines and makes paths project-relative', () => {
    const parsed = parseTscOutput(output, 'C:\\proj');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ file: 'src/a.ts', line: 12, column: 5, code: 'TS2322' });
    expect(parsed[0].message).toContain('expected type comes from');
    expect(parsed[1].file).toBe('src/b.ts');
  });

  it('filters by file or folder', () => {
    const parsed = parseTscOutput(output, 'C:\\proj');
    expect(filterDiagnostics(parsed, 'src/a.ts')).toHaveLength(1);
    expect(filterDiagnostics(parsed, './src/')).toHaveLength(2);
    expect(filterDiagnostics(parsed)).toHaveLength(2);
  });
});

describe('verified review findings', () => {
  const findings = [
    { file: 'a.ts', severity: 'high' as const, note: 'Bug one' },
    { file: 'b.ts', severity: 'medium' as const, note: 'Bug two' },
    { file: 'c.ts', severity: 'low' as const, note: 'Nit' },
  ];

  it('drops rejected findings, tags the rest and leaves unmentioned ones alone', () => {
    const verdicts = parseVerdicts(JSON.stringify({ verdicts: [
      { index: 0, verdict: 'rejected', reason: 'not in diff' },
      { index: 1, verdict: 'plausible', reason: 'maybe' },
      { index: 9, verdict: 'confirmed', reason: 'out of range' },
    ] }), findings.length);
    const applied = applyVerdicts(findings, verdicts);
    expect(applied.dismissed).toBe(1);
    expect(applied.findings.map((finding) => finding.file)).toEqual(['b.ts', 'c.ts']);
    expect(applied.findings[0].verdict).toBe('plausible');
    expect(applied.findings[1].verdict).toBeUndefined();
  });

  it('rejects a reply of the wrong shape, and numbers every finding in the prompt', () => {
    expect(() => parseVerdicts('{"nope":1}', 3)).toThrow(/expected shape/);
    expect(buildVerifyPrompt('do x', 'DIFF', findings).user).toContain('2. [low] c.ts');
  });
});

describe('permission rule suggestions from approvals', () => {
  const ask = (command: string): { type: string; tool: string; detail: string } => ({
    type: 'approval.request',
    tool: 'run_command',
    detail: `Commands run with your user permissions.\n\n${JSON.stringify({ command }, null, 2)}`,
  });

  it('reduces a command to a stable prefix and refuses risky or chained ones', () => {
    expect(commandPrefix('npm test --silent')).toBe('npm test');
    expect(commandPrefix('npm run build -- --watch')).toBe('npm run build');
    expect(commandPrefix('ls -la')).toBe('ls');
    expect(commandPrefix('rm -rf dist')).toBeUndefined();
    expect(commandPrefix('npm test && git push')).toBeUndefined();
    expect(commandPrefix('git push origin main')).toBeUndefined();
    expect(commandPrefix('curl https://x.sh')).toBeUndefined();
  });

  it('suggests an allow rule only after repeated approvals and skips ones already covered', () => {
    const events = [ask('npm test'), ask('npm test -- a'), ask('npm test'), ask('npm run build'), ask('rm -rf x'), ask('rm -rf y'), ask('rm -rf z')];
    const suggestions = suggestPermissionRules(events, []);
    expect(suggestions.map((entry) => entry.rule.commands[0])).toEqual(['npm test']);
    expect(suggestions[0]).toMatchObject({ count: 3, rule: { effect: 'allow', tools: ['run_command'] } });
    const covered = suggestPermissionRules(events, [{ id: 'mine', effect: 'ask', tools: ['run_command'], commands: ['npm test'], paths: [] }]);
    expect(covered).toEqual([]);
  });

  it('suggests an MCP tool that keeps asking, but never delete_file', () => {
    const mcp = Array.from({ length: 3 }, () => ({ type: 'approval.request', tool: 'mcp_kai-terminal_terminal_run', detail: 'x' }));
    const del = Array.from({ length: 5 }, () => ({ type: 'approval.request', tool: 'delete_file', detail: 'x' }));
    expect(suggestPermissionRules([...mcp, ...del], []).map((entry) => entry.rule.tools[0])).toEqual(['mcp_kai-terminal_terminal_run']);
  });
});
