import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { diffHunks, revertHunks, splitLines } from '../packages/contracts/src';
import {
  FileConflictError,
  createProjectFolder,
  deleteProjectPath,
  fileChangedOnDisk,
  listProjectFiles,
  readProjectFile,
  renameProjectPath,
  resolveInside,
  writeProjectFile,
} from '../apps/desktop/src/main/project-files';

const directories: string[] = [];

async function project(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-files-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('project boundary', () => {
  it('rejects parent traversal, absolute paths and drive paths', async () => {
    const root = await project();
    await expect(resolveInside(root, '../outside.txt')).rejects.toThrow(/outside the project/);
    await expect(resolveInside(root, 'a/../../outside.txt')).rejects.toThrow(/outside the project/);
    await expect(resolveInside(root, path.resolve(root, 'a.txt'))).rejects.toThrow(/relative/);
    await expect(resolveInside(root, 'C:\\Windows\\win.ini')).rejects.toThrow(/relative/);
    await expect(resolveInside(root, '')).rejects.toThrow();
    await expect(resolveInside(root, 'ok/new/file.ts')).resolves.toContain(path.join('ok', 'new', 'file.ts'));
  });

  it('rejects a link that leaves the project, for reads and for writes through it', async () => {
    const root = await project();
    const outside = await project();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    await expect(readProjectFile(root, 'link/secret.txt')).rejects.toThrow(/through a link/);
    await expect(writeProjectFile(root, 'link/new.txt', 'x', { expectedHash: null, eol: 'lf', bom: false })).rejects.toThrow(/through a link/);
    await expect(fs.readdir(outside)).resolves.toEqual(['secret.txt']);
  });
});

describe('reading files', () => {
  it('detects CRLF, a BOM and returns a content hash', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'win.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
    const opened = await readProjectFile(root, 'win.txt');
    expect(opened).toMatchObject({ path: 'win.txt', content: 'a\r\nb\r\n', eol: 'crlf', bom: true });
    expect(opened.hash).toMatch(/^[0-9a-f]{64}$/);
    const unix = await fs.writeFile(path.join(root, 'unix.txt'), 'a\nb\n').then(() => readProjectFile(root, 'unix.txt'));
    expect(unix).toMatchObject({ eol: 'lf', bom: false });
  });

  it('refuses binary files, invalid UTF-8 and oversized files', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'image.dat'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(1_000_001));
    await expect(readProjectFile(root, 'image.dat')).rejects.toThrow(/Binary/);
    await expect(readProjectFile(root, 'latin1.txt')).rejects.toThrow(/Binary/);
    await expect(readProjectFile(root, 'big.txt')).rejects.toThrow(/too large/);
    await expect(readProjectFile(root, 'missing.txt')).rejects.toThrow();
  });
});

describe('writing files', () => {
  it('keeps CRLF and the BOM even when the editor hands back LF text', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'win.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
    const opened = await readProjectFile(root, 'win.txt');
    await writeProjectFile(root, 'win.txt', 'one\nTWO\nthree\n', { expectedHash: opened.hash, eol: opened.eol, bom: opened.bom });
    const raw = await fs.readFile(path.join(root, 'win.txt'));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.subarray(3).toString('utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('refuses to overwrite a file that was edited elsewhere, and leaves it untouched', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'a.ts'), 'original');
    const opened = await readProjectFile(root, 'a.ts');
    await fs.writeFile(path.join(root, 'a.ts'), 'changed by an agent');
    expect(await fileChangedOnDisk(root, 'a.ts', opened.hash)).toBe(true);
    await expect(writeProjectFile(root, 'a.ts', 'my edit', { expectedHash: opened.hash, eol: 'lf', bom: false })).rejects.toBeInstanceOf(FileConflictError);
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf8')).toBe('changed by an agent');
  });

  it('treats a file deleted since opening as a conflict, and creates new files only when no hash is expected', async () => {
    const root = await project();
    await fs.writeFile(path.join(root, 'a.ts'), 'x');
    const opened = await readProjectFile(root, 'a.ts');
    await fs.rm(path.join(root, 'a.ts'));
    await expect(writeProjectFile(root, 'a.ts', 'y', { expectedHash: opened.hash, eol: 'lf', bom: false })).rejects.toBeInstanceOf(FileConflictError);
    const written = await writeProjectFile(root, 'src/new.ts', 'created\n', { expectedHash: null, eol: 'lf', bom: false });
    expect(await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('created\n');
    expect(await fileChangedOnDisk(root, 'src/new.ts', written.hash)).toBe(false);
  });

  it('leaves no temporary file behind', async () => {
    const root = await project();
    await writeProjectFile(root, 'a.txt', 'x', { expectedHash: null, eol: 'lf', bom: false });
    expect(await fs.readdir(root)).toEqual(['a.txt']);
  });
});

describe('file listing', () => {
  it('respects .gitignore in a repository and hides binary, large and dependency files', async () => {
    const root = await project();
    execFileSync('git', ['init', '-q'], { cwd: root });
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\nbuild/\n');
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'build'));
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'x');
    await fs.writeFile(path.join(root, 'build', 'out.js'), 'x');
    await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'x');
    await fs.writeFile(path.join(root, 'logo.png'), 'x');
    await fs.writeFile(path.join(root, 'huge.txt'), 'x'.repeat(1_000_001));
    const { files } = await listProjectFiles(root);
    expect(files.map((file) => file.path)).toEqual(['.gitignore', 'src/a.ts']);
  });

  it('walks a plain folder without git, skipping dependency folders and links', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'x');
    await fs.writeFile(path.join(root, 'main.py'), 'print(1)');
    const { files, truncated } = await listProjectFiles(root);
    expect(files.map((file) => file.path)).toEqual(['main.py']);
    expect(truncated).toBe(false);
  });
});

describe('hunk diff', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''].join('\n');
  const after = ['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine', ''].join('\n');

  it('groups changes into separate hunks with old and new line numbers', () => {
    const hunks = diffHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ id: 0, oldStart: 1, newStart: 1, removed: ['one\n'], added: ['ONE\n'] });
    expect(hunks[1]).toMatchObject({ id: 1, oldStart: 8, removed: ['eight\n'], added: ['EIGHT\n', 'nine\n'] });
    expect(hunks[1]?.contextBefore).toEqual(['six\n', 'seven\n']);
  });

  it('rejects one hunk and keeps the other', () => {
    expect(revertHunks(before, after, [0])).toBe(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine', ''].join('\n'));
    expect(revertHunks(before, after, [1])).toBe(['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''].join('\n'));
  });

  it('reverting every hunk restores the original and reverting none keeps the edit', () => {
    const ids = diffHunks(before, after).map((hunk) => hunk.id);
    expect(revertHunks(before, after, ids)).toBe(before);
    expect(revertHunks(before, after, [])).toBe(after);
  });

  it('preserves CRLF line endings exactly when reverting', () => {
    const oldText = 'a\r\nb\r\nc\r\n';
    const newText = 'a\r\nB\r\nc\r\nd\r\n';
    expect(splitLines(oldText)).toEqual(['a\r\n', 'b\r\n', 'c\r\n']);
    expect(revertHunks(oldText, newText, [0])).toBe('a\r\nb\r\nc\r\nd\r\n');
    expect(revertHunks(oldText, newText, [1])).toBe('a\r\nB\r\nc\r\n');
  });

  it('handles new files, deleted files and identical text', () => {
    expect(diffHunks('', 'a\nb\n')).toEqual([expect.objectContaining({ removed: [], added: ['a\n', 'b\n'] })]);
    expect(revertHunks('', 'a\nb\n', [0])).toBe('');
    expect(diffHunks('a\n', '')).toEqual([expect.objectContaining({ removed: ['a\n'], added: [] })]);
    expect(diffHunks('same\n', 'same\n')).toEqual([]);
  });

  it('treats a missing trailing newline as a change to that line only', () => {
    const hunks = diffHunks('a\nb', 'a\nb\n');
    expect(hunks).toHaveLength(1);
    expect(revertHunks('a\nb', 'a\nb\n', [0])).toBe('a\nb');
  });
});

describe('file actions', () => {
  it('deletes a file and a folder, and refuses the project root and .git', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a');
    await fs.writeFile(path.join(root, 'b.ts'), 'b');

    await deleteProjectPath(root, 'b.ts');
    await expect(fs.stat(path.join(root, 'b.ts'))).rejects.toThrow();
    await deleteProjectPath(root, 'src');
    await expect(fs.stat(path.join(root, 'src'))).rejects.toThrow();
    await expect(deleteProjectPath(root, '.git')).rejects.toThrow(/Git folder/);
    await expect(deleteProjectPath(root, '')).rejects.toThrow(/root/);
  });

  it('renames a file and a folder, and refuses an existing destination', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a');
    await fs.writeFile(path.join(root, 'b.ts'), 'b');

    await renameProjectPath(root, 'src/a.ts', 'src/c.ts');
    await expect(fs.readFile(path.join(root, 'src', 'c.ts'), 'utf8')).resolves.toBe('a');
    await renameProjectPath(root, 'src', 'lib');
    await expect(fs.readFile(path.join(root, 'lib', 'c.ts'), 'utf8')).resolves.toBe('a');
    await expect(renameProjectPath(root, 'b.ts', 'lib/c.ts')).rejects.toThrow(/already exists/);
  });

  it('creates a folder, including parents, and refuses .git', async () => {
    const root = await project();
    await createProjectFolder(root, 'src/components/ui');
    await expect(fs.stat(path.join(root, 'src', 'components', 'ui'))).resolves.toBeTruthy();
    await expect(createProjectFolder(root, '.git/hooks')).rejects.toThrow(/Git folder/);
  });
});
