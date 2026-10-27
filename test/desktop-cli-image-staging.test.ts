import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextChip } from '@kai/contracts';
import { renderContextChips, stageAttachmentForCli } from '../apps/desktop/src/main/ipc';

/**
 * A CLI agent's own file tools (Claude, Qwen, Gemini, Kimi — everyone but Codex, which gets an explicit `--image`
 * flag) only trust paths inside the project it was started in. An attachment left in KAI's own userData folder was a
 * path those agents had no way to open, so a prompt that named it was pointing at a file they could not reach. The
 * fix stages a copy inside the project before any agent is told about it.
 */

const directories: string[] = [];

beforeEach(() => {});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  // Windows can hand mkdtemp back a short (8.3) form of a path component while every realpath call downstream
  // (resolveInside included) resolves the long form, so tests compare against the same form the code will.
  return realpath(dir);
}

describe('staging an attached image for a CLI agent', () => {
  it('copies it inside the project tree, not the original userData path', async () => {
    const projectPath = await tempDir('kai-cli-stage-project-');
    const attachmentsRoot = await tempDir('kai-cli-stage-attachments-');
    const source = path.join(attachmentsRoot, 'shot.png');
    await writeFile(source, Buffer.from('fake-png-bytes'));

    const staged = await stageAttachmentForCli(projectPath, source);

    expect(staged.startsWith(projectPath)).toBe(true);
    expect(staged).toContain(path.join('.kai', 'tmp', 'attachments', 'shot.png'));
    await expect(readFile(staged)).resolves.toEqual(Buffer.from('fake-png-bytes'));
  });

  it('ignores the staged folder from Git so attachments never get committed', async () => {
    const projectPath = await tempDir('kai-cli-stage-project-');
    const attachmentsRoot = await tempDir('kai-cli-stage-attachments-');
    const source = path.join(attachmentsRoot, 'shot.png');
    await writeFile(source, Buffer.from('fake-png-bytes'));

    await stageAttachmentForCli(projectPath, source);

    const ignore = await readFile(path.join(projectPath, '.kai', 'tmp', 'attachments', '.gitignore'), 'utf8');
    expect(ignore.trim()).toBe('*');
  });

  it('points the prompt and the image list at the staged path, not the attachments-root one', async () => {
    const projectPath = await tempDir('kai-cli-stage-project-');
    const attachmentsRoot = await tempDir('kai-cli-stage-attachments-');
    const source = path.join(attachmentsRoot, 'shot.png');
    await writeFile(source, Buffer.from('fake-png-bytes'));

    const chip: ContextChip = { type: 'image', name: 'shot.png', path: source };
    const { text, imagePaths } = await renderContextChips(projectPath, attachmentsRoot, [chip]);

    expect(imagePaths).toHaveLength(1);
    expect(imagePaths[0]!.startsWith(projectPath)).toBe(true);
    expect(text).toContain(imagePaths[0]!);
    expect(text).not.toContain(source);
  });
});
