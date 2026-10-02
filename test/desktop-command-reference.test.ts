import { describe, expect, it } from 'vitest';
import { ALL_COMMANDS, COMMAND_GROUPS } from '../apps/desktop/src/renderer/src/components/command-reference';

/**
 * The reference is content, so the thing worth testing is that it stays useful as it grows: an entry that names a
 * command but does not say what it does, or gives no example, is worse than no entry — it looks like an answer.
 */
describe('terminal command reference', () => {
  it('explains every command it lists', () => {
    expect(ALL_COMMANDS.length).toBeGreaterThan(10);
    for (const entry of ALL_COMMANDS) {
      expect(entry.name.trim(), 'a command with no name').not.toBe('');
      expect(entry.summary.trim().length, `${entry.name} has no summary`).toBeGreaterThan(10);
      expect(entry.detail.trim().length, `${entry.name} has no explanation`).toBeGreaterThan(40);
      expect(entry.useWhen.trim().length, `${entry.name} does not say when to use it`).toBeGreaterThan(10);
      expect(entry.examples.length, `${entry.name} has no example`).toBeGreaterThan(0);

      for (const example of entry.examples) {
        expect(example.line.trim(), `${entry.name} has an empty example`).not.toBe('');
        // The line is what gets typed; the explanation is what makes it worth typing.
        expect(example.explains.trim().length, `${entry.name}: "${example.line}" is unexplained`).toBeGreaterThan(10);
      }
    }
  });

  it('lists each command once, so the page cannot disagree with itself', () => {
    const names = ALL_COMMANDS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('warns about the commands that can lose work', () => {
    // The staged-commit step is the one that leaves the machine; a beginner should be told before pressing it.
    const git = ALL_COMMANDS.find((entry) => entry.name.includes('commit'));
    expect(git?.caution, 'the commit/push entry lost its caution').toBeTruthy();
  });

  it('covers what a learner actually reaches for first', () => {
    const names = ALL_COMMANDS.map((entry) => entry.name).join(' ');
    for (const expected of ['grep', 'ls', 'cd', 'npm install', 'npm test', 'git status']) {
      expect(names, `${expected} is missing from the reference`).toContain(expected);
    }
    // Every group earns its heading with at least one command under it.
    for (const group of COMMAND_GROUPS) {
      expect(group.commands.length, `${group.title} is empty`).toBeGreaterThan(0);
      expect(group.note.trim().length, `${group.title} has no note`).toBeGreaterThan(10);
    }
  });
});
