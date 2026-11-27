import type { GuidedBuildStep } from '@kai/contracts';
import type { LeadIdeaProposal } from './lead-idea-proposal';

export type LeadIdeaFileChange = { path: string; addition: string };

export function leadIdeaFileChanges(proposal: LeadIdeaProposal, choice: 'approve' | 'change' | 'park', planSource: 'studio-board' | 'plan-file'): LeadIdeaFileChange[] {
  if (choice === 'change') return [];
  const changes: LeadIdeaFileChange[] = [{ path: '.kai/spec/ideas.md', addition: proposal.ideaRecord }];
  if (choice === 'park') return changes;
  changes.push({ path: '.kai/spec/decisions.md', addition: proposal.decisionRecord });
  if (proposal.goalOrScopeChanged && proposal.briefScopeUpdate.trim()) changes.push({ path: '.kai/spec/brief.md', addition: proposal.briefScopeUpdate });
  if (planSource === 'plan-file') {
    const steps = proposal.steps.map((step, index) => [
      `### ${index + 1}. ${step.title}`,
      `Why: ${step.why}`,
      `Files to edit: ${step.filesToEdit.join(', ')}`,
      step.filesToRead.length ? `Files to read: ${step.filesToRead.join(', ')}` : '',
      `Change: ${step.instructions}`,
      `Done checks: ${step.doneChecks.map((check) => `- ${check}`).join('\n')}`,
      `Check command: \`${step.checkCommand}\``,
    ].filter(Boolean).join('\n')).join('\n\n');
    const plan = [`## ${proposal.planTitle}`, steps].filter(Boolean).join('\n\n');
    changes.push({ path: '.kai/spec/plan.md', addition: plan });
  }
  return changes;
}

/** Keeps the exact existing bytes and appends one proposal entry. */
export function appendMarkdownEntry(existing: string, entry: string): string {
  const separator = !existing ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${entry.trim()}\n`;
}

export function lineContentDiff(before: string, after: string): string {
  if (before === after) return '(no text differences)';
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const commonBefore = oldLines.slice(Math.max(0, prefix - 2), prefix).map((line) => `  ${line}`);
  const commonAfter = suffix ? oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + 2).map((line) => `  ${line}`) : [];
  return [...commonBefore, ...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`), ...commonAfter].join('\n');
}

export function leadProposalGuidedSteps(proposal: LeadIdeaProposal): GuidedBuildStep[] {
  return proposal.steps.map((step, index) => ({
    id: `lead_idea_${step.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80)}_${index + 1}`,
    title: step.title,
    why: step.why,
    where: step.filesToEdit[0]!,
    instructions: `${step.instructions}\nFiles to edit: ${step.filesToEdit.join(', ')}${step.filesToRead.length ? `\nFiles to read: ${step.filesToRead.join(', ')}` : ''}\nCheck command: ${step.checkCommand}`,
    acceptanceCriteria: [...step.doneChecks, `Check command passes: ${step.checkCommand}`],
    status: 'pending',
  }));
}
