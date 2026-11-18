import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHITECT_NOTES_PATH, addNote, appendArchitectNote, renderNote } from '../apps/desktop/src/main/architect-notes';

const DAY = new Date('2026-11-18T10:00:00Z');

describe('Architect notes', () => {
  it('renders a dated, labelled entry', () => {
    const entry = renderNote({ kind: 'plan', title: 'Add the  copilot\nview', lines: ['Goal: x', '', 'Done when:'] }, DAY);
    expect(entry).toBe('## 2026-11-18 · Plan · Add the copilot view\nGoal: x\nDone when:');
  });

  it('keeps the newest thirty entries', () => {
    let file = '';
    for (let index = 0; index < 40; index += 1) file = addNote(file, `## 2026-11-18 · Plan · goal ${index}\nbody`);
    const entries = file.split('\n').filter((line) => line.startsWith('## '));
    expect(entries).toHaveLength(30);
    expect(entries[0]).toContain('goal 10');
    expect(entries.at(-1)).toContain('goal 39');
    expect(file.startsWith('# Architect notes')).toBe(true);
  });

  it('stays under its size limit by dropping the oldest, never the newest', () => {
    let file = '';
    for (let index = 0; index < 12; index += 1) file = addNote(file, `## 2026-11-18 · Plan · goal ${index}\n${'x'.repeat(1_500)}`);
    expect(file.length).toBeLessThanOrEqual(12_000);
    expect(file).toContain('goal 11');
    expect(file).not.toContain('goal 0\n');
  });

  it('creates the file on the first note and adds to it after', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-notes-'));
    try {
      await appendArchitectNote(root, { kind: 'plan', title: 'First', lines: ['one'] }, DAY);
      await appendArchitectNote(root, { kind: 'approved', title: 'First', lines: ['looks right'] }, DAY);
      const text = await fs.readFile(path.join(root, ARCHITECT_NOTES_PATH), 'utf8');
      expect(text).toContain('· Plan · First');
      expect(text).toContain('· Approved · First');
      expect(text.indexOf('Plan')).toBeLessThan(text.indexOf('Approved'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
