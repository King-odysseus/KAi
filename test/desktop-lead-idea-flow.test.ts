import { describe, expect, it } from 'vitest';
import { mergePlanProgress } from '../apps/desktop/src/renderer/src/components/guided-build-engine';
import { appendMarkdownEntry, leadIdeaFileChanges, leadProposalGuidedSteps, lineContentDiff } from '../apps/desktop/src/renderer/src/components/lead-idea-files';
import { leadIdeaCoachPrompt, parseLeadIdeaProposal, type LeadIdeaProposal } from '../apps/desktop/src/renderer/src/components/lead-idea-proposal';

const proposal: LeadIdeaProposal = {
  status: 'proposal', title: 'Saved search', summary: 'Save the current search.', why: 'It avoids retyping.', how: 'Store a named query.',
  risks: ['Keep private searches local.'], simplerOption: 'Keep one recent search.', learning: 'You will learn how app preferences persist.',
  questions: [], conflicts: [], ideaRecord: '### Saved search\nA named saved query.', decisionRecord: '### Saved search\nStore saved queries in project preferences.',
  goalOrScopeChanged: true, briefScopeUpdate: '### Scope update\nSaved searches are included.', planTitle: 'Saved search plan',
  steps: [{ title: 'Save query', why: 'Persist the filter.', filesToEdit: ['src/search.ts'], filesToRead: ['src/preferences.ts'], instructions: 'Save and restore the query.', doneChecks: ['Saved query appears after restart.'], checkCommand: 'npm test -- search' }],
};

function marked(value: unknown): string { return `LEAD_IDEA_PROPOSAL\n${JSON.stringify(value)}\nEND_LEAD_IDEA_PROPOSAL`; }

describe('Lead new-idea proposal and approval flow', () => {
  it('asks no more than three questions and requires a valid structured proposal', () => {
    const prompt = leadIdeaCoachPrompt({ idea: 'Add saved searches', planTitle: 'Current plan', steps: [], style: 'tutor', detail: 'step-by-step', questions: 'decisions' });
    expect(prompt).toContain('no more than three questions');
    expect(parseLeadIdeaProposal(marked({ ...proposal, status: 'questions', questions: ['One?', 'Two?', 'Three?', 'Four?'] }))).toBeNull();
    expect(parseLeadIdeaProposal(marked({ ...proposal, questions: [] }))).toMatchObject({ title: 'Saved search', status: 'proposal' });
  });

  it('Change sends no file writes, Park only records the idea, and Approve records decisions and the plan', () => {
    expect(leadIdeaFileChanges(proposal, 'change', 'plan-file')).toEqual([]);
    expect(leadIdeaFileChanges(proposal, 'park', 'plan-file').map((change) => change.path)).toEqual(['.kai/spec/ideas.md']);
    expect(leadIdeaFileChanges(proposal, 'approve', 'plan-file').map((change) => change.path)).toEqual([
      '.kai/spec/ideas.md', '.kai/spec/decisions.md', '.kai/spec/brief.md', '.kai/spec/plan.md',
    ]);
  });

  it('uses the Studio board as the plan source when present', () => {
    expect(leadIdeaFileChanges(proposal, 'approve', 'studio-board').map((change) => change.path)).toEqual([
      '.kai/spec/ideas.md', '.kai/spec/decisions.md', '.kai/spec/brief.md',
    ]);
  });

  it('preserves file contents by appending and shows changed lines before another approval', () => {
    expect(appendMarkdownEntry('My hand-written decision\n', 'New decision')).toBe('My hand-written decision\n\nNew decision\n');
    expect(lineContentDiff('before\nmy edit\nafter', 'before\nnew edit\nafter')).toContain('- my edit\n+ new edit');
  });

  it('protects completed Guided Build steps when the approved plan is merged', () => {
    const previous = leadProposalGuidedSteps(proposal).map((step) => ({ ...step, status: 'complete' as const }));
    const updated = leadProposalGuidedSteps({ ...proposal, steps: [...proposal.steps, { ...proposal.steps[0]!, title: 'Add a clear button' }] });
    const merged = mergePlanProgress(updated, previous);
    expect(merged.steps[0]?.status).toBe('complete');
    expect(merged.steps[1]?.status).toBe('active');
  });

  it('accepts a conflict or not-yet response without presenting it as ready to write', () => {
    expect(parseLeadIdeaProposal(marked({ ...proposal, status: 'not_yet', steps: [] }))).toMatchObject({ status: 'not_yet' });
    expect(parseLeadIdeaProposal(marked({ ...proposal, status: 'conflict', conflicts: ['This differs from decisions.md.'], steps: [] }))).toMatchObject({ status: 'conflict' });
  });
});
