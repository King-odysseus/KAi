import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The Architect's notes on a project: its plans and what its reviews decided, in a file every later run reads with the
 * project's other instruction files (see `context-builder.ts`). The Implementer, the Worker and a local model that
 * compacts early all start from it, so a decision made in one conversation is still there in the next.
 *
 * KAI writes it, from the Architect's own plans and verdicts, rather than asking the Architect to: a model asked to
 * remember to write notes forgets, and this does not depend on it remembering.
 */
export const ARCHITECT_NOTES_PATH = '.kai/ARCHITECT.md';

const HEADER = [
  '# Architect notes',
  "Kept by KAI from the Architect's plans and reviews, newest last. Read these before you build: they are the direction and the decisions already made for this project. If one is out of date, say so in your reply instead of following it blindly.",
].join('\n\n');
const MAX_ENTRIES = 30;
const MAX_CHARACTERS = 12_000;
const MAX_ENTRY_CHARACTERS = 1_800;

export interface ArchitectNote {
  kind: 'plan' | 'approved' | 'revise' | 'replan' | 'step-in';
  /** The goal or the one-line summary the note is about. */
  title: string;
  lines: readonly string[];
}

const KIND_LABEL: Record<ArchitectNote['kind'], string> = {
  plan: 'Plan',
  approved: 'Approved',
  revise: 'Sent back',
  replan: 'Re-planned',
  'step-in': 'Architect stepped in',
};

export function renderNote(note: ArchitectNote, now: Date): string {
  const body = note.lines.map((line) => line.trim()).filter(Boolean).join('\n');
  return `## ${now.toISOString().slice(0, 10)} · ${KIND_LABEL[note.kind]} · ${note.title.replace(/\s+/g, ' ').trim().slice(0, 160)}\n${body}`.slice(0, MAX_ENTRY_CHARACTERS);
}

/** Adds a note to the entries already in the file; the oldest fall off past the limits. */
export function addNote(existing: string, note: string): string {
  const entries = existing
    .split(/\r?\n(?=## )/)
    .slice(1)
    .map((entry) => entry.trim())
    .filter(Boolean);
  entries.push(note.trim());
  let kept = entries.slice(-MAX_ENTRIES);
  const size = (): number => HEADER.length + kept.reduce((total, entry) => total + entry.length + 2, 0);
  while (kept.length > 1 && size() > MAX_CHARACTERS) kept = kept.slice(1);
  return `${HEADER}\n\n${kept.join('\n\n')}\n`;
}

export async function appendArchitectNote(projectRoot: string, note: ArchitectNote, now: Date = new Date()): Promise<void> {
  const file = path.join(projectRoot, ARCHITECT_NOTES_PATH);
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    // The first note creates the file.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next = addNote(existing, renderNote(note, now));
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, next, 'utf8');
  await fs.rename(temporary, file);
}
