import { describe, expect, it } from 'vitest';
import { authoritativeLeadFiles } from '../apps/desktop/src/renderer/src/components/lead-project-context';

it('keeps the project plan without Studio, and sends only the board plan when Studio owns it', () => {
  const plan = { path: '.kai/spec/plan.md', content: 'The next agreed step.' };
  const decisions = { path: '.kai/spec/decisions.md', content: 'Keep finished work.' };
  const board = { path: '.kai/spec/board.json', content: '{"cards":[]}' };
  expect(authoritativeLeadFiles([plan, decisions])).toEqual([plan, decisions]);
  expect(authoritativeLeadFiles([plan, decisions, board])).toEqual([decisions, board]);
});
import { buildLeadSpecContext, isLeadUiRequest } from '../apps/desktop/src/renderer/src/components/lead-project-context';

describe('Lead Project Studio context', () => {
  it('prioritizes brief and relevant sections, and reports omitted sections within budget', () => {
    const result = buildLeadSpecContext([
      { path: '.kai/spec/brief.md', content: '# Goal\nA small photo library.\n\n## Rules\nKeep originals safe.' },
      { path: '.kai/spec/decisions.md', content: '# Choices\n\n## Storage\nUse SQLite for the catalog.\n\n## Unrelated\n'.concat('details '.repeat(100)) },
    ], 'How does SQLite store the photo catalog?', 300);
    expect(result.text).toContain('SQLite');
    expect(result.text).toContain('Sections omitted');
    expect(result.text.length).toBeLessThan(500);
  });

  it('does not return half of an oversized fenced code example', () => {
    const result = buildLeadSpecContext([{ path: '.kai/spec/architecture.md', content: '# Diagram\n```mermaid\n'.concat('A-->B\n'.repeat(40), '```') }], 'architecture diagram', 60);
    expect(result.text).not.toContain('```mermaid');
    expect(result.omitted.some((entry) => entry.includes('Diagram'))).toBe(true);
  });

  it('does not treat a heading inside a fence as a section boundary', () => {
    const content = '# Example\n```md\n# literal heading\nline\n```\n';
    const result = buildLeadSpecContext([{ path: '.kai/spec/brief.md', content }], 'literal heading', 200);
    expect(result.text).toContain('```md\n# literal heading\nline\n```');
  });

  it('includes relevant complete DESIGN.md sections and names sections left out', () => {
    const result = buildLeadSpecContext([{ path: 'DESIGN.md', content: '# Colours\nUse muted teal for links.\n\n## Buttons\nButtons use a 12px radius and clear focus rings.\n\n## Printing\n'.concat('print rules '.repeat(50)) }], 'Restyle the buttons with a clear focus ring', 180);
    expect(result.text).toContain('## Buttons\nButtons use a 12px radius and clear focus rings.');
    expect(result.text).toContain('Sections omitted');
    expect(result.omitted.some((section) => section.includes('Printing'))).toBe(true);
  });

  it('only requests visual design guidance for UI work', () => {
    expect(isLeadUiRequest('Change the settings page layout')).toBe(true);
    expect(isLeadUiRequest('Review the database design for migrations')).toBe(false);
  });
});
