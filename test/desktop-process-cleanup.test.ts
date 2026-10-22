import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_REFUSAL, launchesBackgroundProcess, processCleanupScript, stopProcessesInFolders } from '../apps/desktop/src/main/process-cleanup';

vi.setConfig({ testTimeout: 30_000 });

describe('refusing to leave something running in a card\'s copy of the project', () => {
  it('knows the ways a command stays running after it returns', () => {
    for (const command of [
      'node scripts/preview.js &',
      '(node scripts/preview.js > /tmp/preview.log 2>&1 &) ; sleep 4; cat /tmp/preview.log | head -8',
      'cd app && node server.js &',
      'nohup node server.js',
      'setsid node server.js',
      'start /b node server.js',
      'Start-Process node -ArgumentList server.js',
    ]) expect(launchesBackgroundProcess(command), command).toBe(true);
  });

  it('leaves ordinary commands alone, including ones that merely contain an ampersand', () => {
    for (const command of [
      'npm test',
      'npm run build && npm test',
      'node scripts/check.js 2>&1',
      'echo "fish & chips"',
      'git status && git diff\nnpm test',
      'grep -r "a && b" src',
    ]) expect(launchesBackgroundProcess(command), command).toBe(false);
  });

  it('tells the agent why, and what to do instead', () => {
    expect(BACKGROUND_REFUSAL).toContain('keeps the folder and its port locked');
    expect(BACKGROUND_REFUSAL).toContain('run that instead');
  });
});

describe('stopping what a card left running in its copy', () => {
  it('names a copy by the part of its path that does not depend on how Windows spells the temp folder', () => {
    const script = processCleanupScript(['C:\\Users\\MEGA-M~1\\AppData\\Local\\Temp\\kai-parallel\\autopilot-studio_b84c-3']);
    expect(script).toContain("'kai-parallel\\autopilot-studio_b84c-3'");
    expect(script).toContain("'kai-parallel/autopilot-studio_b84c-3'");
    expect(script).not.toContain('MEGA-M');
  });

  it('never stops itself or anything above it', () => {
    const script = processCleanupScript(['C:\\Temp\\kai-parallel\\wave-1']);
    expect(script).toContain('$self = $PID');
    expect(script).toContain('$keep.Contains');
  });

  it('does nothing when there is nothing to look for', async () => {
    expect(await stopProcessesInFolders([])).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('stops a server started as `node scripts/preview.js` that holds a copy only by working there', async () => {
    const wave = `cleanup-test-${Math.random().toString(36).slice(2, 10)}`;
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kai-cleanup-'));
    const folder = path.join(parent, 'kai-parallel', wave);
    await mkdir(path.join(folder, 'card'), { recursive: true });
    // Nothing in its command line names the copy; only the folder it was started in does.
    const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: path.join(folder, 'card'), stdio: 'ignore', windowsHide: true });
    const elsewhere = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: parent, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = await stopProcessesInFolders([folder]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(stopped).toBeGreaterThanOrEqual(1);
      expect(held.exitCode !== null || held.signalCode !== null).toBe(true);
      expect(elsewhere.exitCode === null && elsewhere.signalCode === null).toBe(true);
    } finally {
      held.kill();
      elsewhere.kill();
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  });

  it.skipIf(process.platform !== 'win32')('stops a process that is running in a copy, and one it started, and no other', async () => {
    const wave = `cleanup-test-${Math.random().toString(36).slice(2, 10)}`;
    const folder = `C:\\Temp\\kai-parallel\\${wave}`;
    const keep = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
    const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', `kai-parallel/${wave}/0-1`], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = await stopProcessesInFolders([folder]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(stopped).toBeGreaterThanOrEqual(1);
      expect(held.exitCode !== null || held.signalCode !== null).toBe(true);
      expect(keep.exitCode === null && keep.signalCode === null).toBe(true);
    } finally {
      keep.kill();
      held.kill();
    }
  });
});
