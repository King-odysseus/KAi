import { describe, expect, it } from 'vitest';
import { agentRunRequestSchema } from '@kai/contracts';
import { buildLeadRequestText, LEAD_PROMPT_LIMIT, type LeadSpecFile } from '../apps/desktop/src/renderer/src/components/lead-project-context';
import { leadCoachPrompt, learnPrompt, type LearnAction } from '../apps/desktop/src/renderer/src/components/guided-build-engine';

const step = { title: 'Add the search box', where: 'src/search.ts', instructions: 'Connect the search field to the existing filter.' };
const styles = { style: 'tutor' as const, detail: 'step-by-step' as const, questions: 'blocked' as const };

function request(question: string, specFiles: LeadSpecFile[] = [], openFile?: LeadSpecFile, includeProjectOrientation = false) {
  const text = buildLeadRequestText({ question, specFiles, ...(openFile ? { openFile } : {}), includeProjectOrientation, ...styles, leadCoachPrompt });
  const parsed = agentRunRequestSchema.safeParse({
    conversationId: 'lead_project_1',
    prompt: text.prompt,
    displayText: text.displayText,
    agent: 'codex',
    execution: 'cli',
    route: 'direct',
    autonomy: 'plan',
  });
  return { text, parsed };
}

describe('real Lead requests fit the agent run contract', () => {
  it('keeps a question longer than the former displayText limit whole', () => {
    const question = `Please explain this design decision. ${'The saved question must stay complete. '.repeat(35)}`;
    const { text, parsed } = request(question);
    expect(parsed.success).toBe(true);
    expect(text.displayText).toBe(question);
    expect(text.prompt).toContain(question);
    expect(text.prompt.length).toBeLessThanOrEqual(LEAD_PROMPT_LIMIT);
  });

  it('budgets a large open file as complete relevant source sections and names omissions', () => {
    const file = [
      'export function findCustomer(query: string) {\n  return database.search(query);\n}',
      ...Array.from({ length: 70 }, (_, index) => `export function unrelated${index}() {\n  return "${'padding '.repeat(70)}";\n}`),
    ].join('\n\n');
    const { text, parsed } = request('How does findCustomer search the database?', [], { path: 'src/search.ts', content: file });
    expect(parsed.success).toBe(true);
    expect(text.prompt.length).toBeLessThanOrEqual(LEAD_PROMPT_LIMIT);
    expect(text.prompt).toContain('export function findCustomer(query: string) {\n  return database.search(query);\n}');
    expect(text.prompt).toContain('Sections omitted to fit the request');
    expect(text.omitted).toContain('src/search.ts — export function unrelated69() {');
  });

  it('budgets large spec files together with the full question', () => {
    const specs = Array.from({ length: 5 }, (_, fileIndex) => ({
      path: `.kai/spec/${['brief', 'decisions', 'architecture', 'status', 'risks'][fileIndex]}.md`,
      content: [
        '# Goal\nThe project stores customer records in SQLite.',
        ...Array.from({ length: 20 }, (_, section) => `\n## Section ${section}\n${'Long background detail. '.repeat(45)}`),
      ].join('\n'),
    }));
    const question = `Why does SQLite store customer records? ${'Please keep this complete. '.repeat(25)}`;
    const { text, parsed } = request(question, specs);
    expect(parsed.success).toBe(true);
    expect(text.displayText).toBe(question);
    expect(text.prompt.length).toBeLessThanOrEqual(LEAD_PROMPT_LIMIT);
    expect(text.prompt).toContain('The project stores customer records in SQLite.');
    expect(text.prompt).toContain('Sections omitted to fit the request');
  });

  it.each<LearnAction>(['walk', 'simpler', 'quiz'])('validates the %s teaching action as a real request', (action) => {
    const question = learnPrompt(action, step, 'tutor', 'step-by-step');
    const { text, parsed } = request(question);
    expect(parsed.success).toBe(true);
    expect(text.displayText).toBe(question);
    expect(text.prompt.length).toBeLessThanOrEqual(LEAD_PROMPT_LIMIT);
  });

  it('sends the project goal and next-step direction only on the first turn or Studio handoff', () => {
    const first = request('First question', [], undefined, true);
    const followup = request('Follow up');
    expect(first.text.prompt).toContain('Begin by stating the project goal and next useful step');
    expect(followup.text.prompt).not.toContain('Begin by stating the project goal and next useful step');
    expect(followup.text.prompt).toContain('Lead is always read-only');
  });
});
