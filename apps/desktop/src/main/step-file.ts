import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ArchitectBrief } from '@kai/contracts';

/**
 * The step file: a local builder's plan and its notes, on disk, for one Architect run.
 *
 * A local builder works one step per fresh turn, so nothing it learns in one step is in its context for the next. The
 * file is where that goes: KAI writes the brief and the steps into it and ticks each step off when its turn ends; the
 * builder adds what the next step should know under "Notes for the next step". The next turn, a turn after a fold, and
 * the Architect when it reviews or steps in all read the same file.
 *
 * It lives in a folder that ignores itself in Git, so it is never committed and never shows up in a review's diff.
 */
export const STEP_FOLDER = '.kai/steps';
export const NOTES_HEADING = '## Notes for the next step';

export function stepFilePath(conversationId: string): string {
  return `${STEP_FOLDER}/${conversationId.replace(/[^A-Za-z0-9_-]/g, '_')}.md`;
}

/** The notes already written, so a new brief after a step-in keeps what the builder had learned. */
export function notesOf(text: string): string {
  const at = text.indexOf(NOTES_HEADING);
  return at < 0 ? '' : text.slice(at + NOTES_HEADING.length).trim();
}

export function renderStepFile(brief: ArchitectBrief, task: string, notes = ''): string {
  const steps = brief.steps ?? [];
  return [
    '# Step plan',
    'Written by KAI from the Architect\'s brief. KAI ticks each step when its turn ends. Builders: read the notes first, and before you finish a step add a few lines under the notes heading saying what the next step needs to know: where things are, what you changed, what surprised you.',
    `## Goal\n${brief.goal}`,
    `## Original request\n${task.length > 1_500 ? `${task.slice(0, 1_500)}…` : task}`,
    ...(brief.files.length ? [`## Files in play\n${brief.files.map((file) => `- ${file}`).join('\n')}`] : []),
    ...(brief.avoid.length ? [`## Leave alone\n${brief.avoid.map((item) => `- ${item}`).join('\n')}`] : []),
    `## Done when\n${brief.doneChecks.map((check) => `- ${check}`).join('\n')}`,
    `## Steps\n${steps.map((step, index) => `- [ ] ${index + 1}. ${step}`).join('\n')}`,
    `${NOTES_HEADING}\n${notes}`,
  ].join('\n\n').trimEnd() + '\n';
}

/** Ticks step `index` (0-based) in the text. Text without that step comes back unchanged. */
export function tickStep(text: string, index: number): string {
  return text.replace(new RegExp(`^- \\[ \\] ${index + 1}\\. `, 'm'), `- [x] ${index + 1}. `);
}

async function ignoreFolder(root: string): Promise<void> {
  const folder = path.join(root, STEP_FOLDER);
  await fs.mkdir(folder, { recursive: true });
  // A .gitignore of "*" ignores the folder's contents, itself included.
  await fs.writeFile(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined);
}

/** Writes the plan for a brief, keeping notes from an earlier brief in the same run. Returns the project-relative path. */
export async function writeStepFile(root: string, conversationId: string, brief: ArchitectBrief, task: string): Promise<string> {
  await ignoreFolder(root);
  const relative = stepFilePath(conversationId);
  const file = path.join(root, relative);
  const previous = await fs.readFile(file, 'utf8').catch(() => '');
  await fs.writeFile(file, renderStepFile(brief, task, notesOf(previous)), 'utf8');
  return relative;
}

export async function tickStepInFile(root: string, conversationId: string, index: number): Promise<void> {
  const file = path.join(root, stepFilePath(conversationId));
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text !== null) await fs.writeFile(file, tickStep(text, index), 'utf8');
}

/** The builder's notes, for the Architect. Empty when there is no file or nothing was written. */
export async function readStepNotes(root: string, conversationId: string): Promise<string> {
  return notesOf(await fs.readFile(path.join(root, stepFilePath(conversationId)), 'utf8').catch(() => ''));
}

/** Whether this run has a step file, so a fold can point the model back to it. */
export async function hasStepFile(root: string, conversationId: string): Promise<boolean> {
  return fs.access(path.join(root, stepFilePath(conversationId))).then(() => true, () => false);
}
