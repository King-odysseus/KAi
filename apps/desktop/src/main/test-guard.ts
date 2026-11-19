/**
 * Test changes a reviewer must not wave through. A builder that cannot make a test pass will often change the test
 * instead: a new expected value, an assertion deleted, a test skipped. Sometimes that is right (the behaviour really
 * did change), and only the reviewer can tell. So these changes are named, from the diff, and the Architect is asked
 * to justify each one before it approves.
 *
 * Input is the review material: each changed file under a `--- <path>` line, followed by its git diff.
 */

const TEST_FILE = /(?:^|[/\\])(?:__tests__|tests?)[/\\]|[._-](?:test|spec)\.[cm]?[jt]sx?$/i;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\.should\b|\bt\.(?:is|deepEqual|true|false|equal)\s*\(/;
const SKIPPED = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|\{\s*skip\s*:\s*true/;
const MAX_FLAGS = 12;

interface FileDiff { path: string; removed: string[]; added: string[] }

/** The changed files in the material, each with the lines its diff removes and adds. */
function filesOf(material: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of material.split(/\r?\n/)) {
    // A section header names the file; the diff's own "--- a/path" and "--- /dev/null" lines are not headers.
    const header = /^--- (?!a\/|\/dev\/null)(\S.*?)(?: \(new or unreadable as a diff\))?$/.exec(line);
    if (header) {
      current = { path: header[1]!.trim(), removed: [], added: [] };
      files.push(current);
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) current.removed.push(line.slice(1).trim());
    else if (line.startsWith('+')) current.added.push(line.slice(1).trim());
  }
  return files;
}

/** What an assertion is about, without what it expects: two lines with the same subject check the same thing. */
export function assertionSubject(line: string): string | null {
  if (!ASSERTION.test(line)) return null;
  const expectMatcher = /^(.*?\))\s*\.(?:not\.)?(?:to|should)\w*/.exec(line);
  if (expectMatcher) return expectMatcher[1]!.replace(/\s+/g, '');
  const call = /^(.*?\bassert(?:\.\w+)?\s*\(\s*[^,]+)/.exec(line);
  return call ? call[1]!.replace(/\s+/g, '') : null;
}

export function weakenedTestFlags(material: string): string[] {
  const flags: string[] = [];
  for (const file of filesOf(material)) {
    if (!TEST_FILE.test(file.path)) continue;
    const removedAssertions = file.removed.filter((line) => ASSERTION.test(line));
    const addedAssertions = file.added.filter((line) => ASSERTION.test(line));
    // The same check with a different expected value.
    const addedBySubject = new Map<string, string>();
    for (const line of addedAssertions) {
      const subject = assertionSubject(line);
      if (subject) addedBySubject.set(subject, line);
    }
    for (const line of removedAssertions) {
      const subject = assertionSubject(line);
      const replacement = subject ? addedBySubject.get(subject) : undefined;
      if (replacement && replacement !== line) flags.push(`${file.path}: an expected value changed. Was: ${line.slice(0, 160)} Now: ${replacement.slice(0, 160)}`);
    }
    if (removedAssertions.length > addedAssertions.length) {
      flags.push(`${file.path}: ${removedAssertions.length - addedAssertions.length} fewer assertion${removedAssertions.length - addedAssertions.length === 1 ? '' : 's'} than before.`);
    }
    for (const line of file.added.filter((added) => SKIPPED.test(added))) flags.push(`${file.path}: a test is now skipped: ${line.slice(0, 160)}`);
  }
  return flags.slice(0, MAX_FLAGS);
}

/** The flags as the reviewer reads them, or nothing when there are none. */
export function testGuardNote(flags: readonly string[]): string {
  if (flags.length === 0) return '';
  return [
    'KAI found these test changes in the diff. A builder that cannot make a test pass sometimes changes the test instead.',
    ...flags.map((flag) => `- ${flag}`),
    'Approve only if each one is justified by the brief or by a reason the builder gave. Otherwise send the work back and say to restore the test and fix the code.',
  ].join('\n');
}
