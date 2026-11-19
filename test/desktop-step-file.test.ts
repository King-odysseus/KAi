import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTES_HEADING, notesOf, readStepNotes, renderStepFile, stepFilePath, tickStep, tickStepInFile, writeStepFile } from '../apps/desktop/src/main/step-file';

const BRIEF = { goal: 'Add the parser', files: ['src/parser.ts'], avoid: ['src/legacy.ts'], doneChecks: ['parser.test.ts passes'], steps: ['Add parse().', 'Split on "=".', 'Add a test.'] };

describe('the step file', () => {
  it('lays out the brief, the steps as boxes and an empty notes section', () => {
    const text = renderStepFile(BRIEF, 'Add a parser');
    expect(text).toContain('## Goal\nAdd the parser');
    expect(text).toContain('- [ ] 1. Add parse().');
    expect(text).toContain('- [ ] 3. Add a test.');
    expect(text).toContain('## Leave alone\n- src/legacy.ts');
    expect(text.trimEnd().endsWith(NOTES_HEADING)).toBe(true);
  });

  it('ticks only the step asked for', () => {
    const ticked = tickStep(renderStepFile(BRIEF, 'x'), 1);
    expect(ticked).toContain('- [ ] 1. Add parse().');
    expect(ticked).toContain('- [x] 2. Split on "=".');
    expect(tickStep('no steps here', 4)).toBe('no steps here');
  });

  it('keeps a safe file name whatever the conversation id holds', () => {
    expect(stepFilePath('conv_abc-1')).toBe('.kai/steps/conv_abc-1.md');
    expect(stepFilePath('../../etc/passwd')).toBe('.kai/steps/______etc_passwd.md');
  });

  it('writes, ticks, keeps notes across a new brief, and ignores itself in Git', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-steps-'));
    try {
      const relative = await writeStepFile(root, 'conv_1', BRIEF, 'Add a parser');
      const file = path.join(root, relative);
      await fs.appendFile(file, '- parse() lives in src/core/parse.ts, not src/parser.ts\n');
      await tickStepInFile(root, 'conv_1', 0);
      expect(await fs.readFile(file, 'utf8')).toContain('- [x] 1. Add parse().');
      expect(await readStepNotes(root, 'conv_1')).toBe('- parse() lives in src/core/parse.ts, not src/parser.ts');
      // The Architect replaces the brief: the steps start over, the builder's notes stay.
      await writeStepFile(root, 'conv_1', { ...BRIEF, steps: ['Fix the import.', 'Add a test.'] }, 'Add a parser');
      const again = await fs.readFile(file, 'utf8');
      expect(again).toContain('- [ ] 1. Fix the import.');
      expect(notesOf(again)).toContain('src/core/parse.ts');
      expect(await fs.readFile(path.join(root, '.kai/steps/.gitignore'), 'utf8')).toBe('*\n');
      expect(await readStepNotes(root, 'missing')).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
