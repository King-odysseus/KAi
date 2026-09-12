import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionRulesBriefing, CognitiveRuleStore } from '../src/cognitive1/rule-store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createStore(markdown: string): Promise<CognitiveRuleStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-rules-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'Instruct.md');
  await fs.writeFile(filePath, markdown, 'utf8');
  return new CognitiveRuleStore(filePath);
}

const fixture = `# Cognitive1

## Session Checklist

1. Pull the brain.
2. Start the session.

---

## Rules

### Security

1. **No API keys ever** - Never commit secrets.

2. **Think OWASP** - Validate input and escape output.

### Testing

3. **Test edge cases** - Include empty and failure cases.

---

## MCP Tools Reference

session_start
`;

describe('CognitiveRuleStore', () => {
  it('loads numbered rules and the session workflow from Instruct.md', async () => {
    const store = await createStore(fixture);
    const document = await store.read();

    expect(document.rules).toHaveLength(3);
    expect(document.rules[0]).toMatchObject({
      id: 'rule-1',
      number: 1,
      section: 'Security',
      title: 'No API keys ever',
      body: '- Never commit secrets.',
    });
    expect(document.sessionWorkflow).toContain('Pull the brain.');
    expect(document.sessionWorkflow).toContain('Start the session.');
  });

  it('edits an existing rule in place', async () => {
    const store = await createStore(fixture);
    const document = await store.save({
      id: 'rule-2',
      title: 'Validate boundaries',
      body: '- Validate input and escape output before database access.',
    });

    expect(document.rules[1].title).toBe('Validate boundaries');
    expect(document.rules[1].body).toContain('before database access');
    expect(document.rules).toHaveLength(3);
  });

  it('preserves the section divider when editing the final rule', async () => {
    const store = await createStore(fixture);
    const document = await store.save({
      id: 'rule-3',
      title: 'Test all boundaries',
      body: '- Include empty, failure, and concurrency cases.',
    });

    expect(document.rules[2].title).toBe('Test all boundaries');
    expect(document.markdown).toContain('3. **Test all boundaries** - Include empty, failure, and concurrency cases.');
    expect(document.markdown).toContain('\n---\n');
  });

  it('adds a new numbered rule under the Custom section', async () => {
    const store = await createStore(fixture);
    const document = await store.save({
      id: '',
      title: 'Keep changes focused',
      body: '- Keep each commit to one logical change.',
    });

    expect(document.rules).toHaveLength(4);
    expect(document.rules[3]).toMatchObject({
      number: 4,
      section: 'Custom',
      title: 'Keep changes focused',
    });
    expect(document.markdown).toContain(
      '3. **Test edge cases** - Include empty and failure cases.\n\n### Custom\n\n4. **Keep changes focused** - Keep each commit to one logical change.\n\n---',
    );
  });
});

describe('buildExecutionRulesBriefing', () => {
  it('returns the full authoritative instruction file in a prompt preamble', () => {
    const briefing = buildExecutionRulesBriefing(fixture);

    expect(briefing).toContain('[COGNITIVE1 STANDING INSTRUCTIONS]');
    expect(briefing).toContain('1. **No API keys ever**');
    expect(briefing).toContain('## Session Checklist');
    expect(briefing).toContain('[/COGNITIVE1 STANDING INSTRUCTIONS]');
  });

  it('returns an empty briefing when the rule file is empty', () => {
    expect(buildExecutionRulesBriefing('   ')).toBe('');
  });
});
