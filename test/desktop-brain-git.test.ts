import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { brainGitStatus, syncBrainGit } from '../apps/desktop/src/main/brain-git';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('desktop brain Git sync', () => {
  it('initializes, commits, and reports a clean isolated brain repository', async () => {
    const root = await temporaryDirectory('kai-brain-git-');
    const brain = path.join(root, 'brain');
    await mkdir(brain, { recursive: true });

    await expect(brainGitStatus(brain)).resolves.toMatchObject({
      repository: false,
      clean: true,
      changedFiles: 0,
      error: null,
    });

    const initialized = await syncBrainGit(brain, 'init');
    expect(initialized).toMatchObject({ action: 'init', success: true });
    expect(initialized.status).toMatchObject({ repository: true, clean: true });

    await configureIdentity(brain);
    await writeFile(path.join(brain, 'entry.md'), 'Remember this fact.\n', 'utf8');
    await expect(brainGitStatus(brain)).resolves.toMatchObject({ repository: true, clean: false, changedFiles: 1 });

    const committed = await syncBrainGit(brain, 'commit');
    expect(committed).toMatchObject({ action: 'commit', success: true });
    expect(committed.status).toMatchObject({ repository: true, clean: true, changedFiles: 0 });

    const noChanges = await syncBrainGit(brain, 'commit');
    expect(noChanges).toMatchObject({ action: 'commit', success: true, message: 'No brain changes to commit.' });

    const pullWithoutRemote = await syncBrainGit(brain, 'pull');
    expect(pullWithoutRemote.success).toBe(false);
    expect(pullWithoutRemote.message.trim().length).toBeGreaterThan(0);
  });

  it('pushes and pulls through an explicit temporary remote without touching user configuration', async () => {
    const root = await temporaryDirectory('kai-brain-sync-');
    const brain = path.join(root, 'brain');
    const remote = path.join(root, 'remote.git');
    await mkdir(brain, { recursive: true });
    await git(root, ['init', '--bare', remote]);

    expect((await syncBrainGit(brain, 'init')).success).toBe(true);
    await configureIdentity(brain);
    await writeFile(path.join(brain, 'entry.md'), 'Portable brain entry.\n', 'utf8');
    expect((await syncBrainGit(brain, 'commit')).success).toBe(true);
    await git(brain, ['remote', 'add', 'origin', remote]);

    const pushed = await syncBrainGit(brain, 'push');
    expect(pushed).toMatchObject({ action: 'push', success: true });
    expect(pushed.status.remote).toBe(remote);
    expect(pushed.status.ahead).toBe(0);
    expect(pushed.status.behind).toBe(0);

    const pulled = await syncBrainGit(brain, 'pull');
    expect(pulled).toMatchObject({ action: 'pull', success: true });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function configureIdentity(repository: string): Promise<void> {
  await git(repository, ['config', 'user.name', 'KAI Test']);
  await git(repository, ['config', 'user.email', 'kai-test@example.invalid']);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return `${stdout}${stderr}`;
}
