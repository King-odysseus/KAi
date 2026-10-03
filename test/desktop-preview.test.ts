import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewRuntime, detectPreviewCandidates, nodePreviewCandidates, previewCommandFromPackage, previewUrlFromOutput, pythonPreviewCandidates } from '../apps/desktop/src/main/preview-runtime';

const directories: string[] = [];
const runtimes: PreviewRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stopAll()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('desktop live preview', () => {
  it('detects the project dev command and a local URL from noisy server output', () => {
    expect(previewCommandFromPackage(JSON.stringify({
      scripts: { build: 'vite build', dev: 'vite --host 127.0.0.1' },
    }))).toBe('npm run dev');
    expect(previewCommandFromPackage('{"scripts":{"start":"node server.js"}}')).toBe('npm run start');
    expect(previewCommandFromPackage('not json')).toBeNull();
    expect(previewUrlFromOutput('\u001b[32mLocal:\u001b[0m http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(previewUrlFromOutput('ready at http://127.0.0.1:4173/, press q')).toBe('http://127.0.0.1:4173/');
    expect(previewUrlFromOutput('no server here')).toBeNull();
  });

  it('counts a script that serves something as the project server, ahead of one that only watches', () => {
    expect(nodePreviewCandidates(JSON.stringify({ scripts: { dev: 'tailwindcss --watch', start: 'vite' } })).map((candidate) => candidate.command)).toEqual(['npm run start', 'npm run dev']);
    expect(nodePreviewCandidates(JSON.stringify({ scripts: { web: 'next dev', build: 'next build' } })).map((candidate) => candidate.command)).toEqual(['npm run web']);
    expect(nodePreviewCandidates('{"scripts":{"test":"vitest"}}')).toEqual([]);
  });

  it('reads the start command out of the Python files rather than guessing', () => {
    expect(pythonPreviewCandidates({ hasManagePy: true, dependencies: '', modules: [] })).toEqual([{ command: 'python manage.py runserver', label: 'Django' }]);
    expect(pythonPreviewCandidates({ hasManagePy: false, dependencies: 'fastapi\nuvicorn[standard]', modules: [{ name: 'main.py', source: 'app = FastAPI()\n' }] })).toEqual([{ command: 'python -m uvicorn main:app --reload', label: 'FastAPI' }]);
    // Named after its own variable, because a Flask app is not always called `app`.
    expect(pythonPreviewCandidates({ hasManagePy: false, dependencies: 'flask', modules: [{ name: 'app.py', source: 'from flask import Flask\napplication = Flask(__name__)\n' }] })).toEqual([{ command: 'python -m flask --app app:application run', label: 'Flask' }]);
    expect(pythonPreviewCandidates({ hasManagePy: false, dependencies: 'requests', modules: [{ name: 'utils.py', source: 'print(1)\n' }] })).toEqual([]);
  });

  it('detects a project with no package.json at all, and puts its server ahead of a watcher script', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-preview-detect-'));
    directories.push(directory);
    await fs.writeFile(path.join(directory, 'manage.py'), 'import django\n', 'utf8');
    await fs.writeFile(path.join(directory, 'requirements.txt'), 'Django==5.0\n', 'utf8');
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { dev: 'tailwindcss --watch' } }), 'utf8');
    await expect(detectPreviewCandidates(directory)).resolves.toEqual([
      { command: 'python manage.py runserver', label: 'Django' },
      { command: 'npm run dev', label: 'npm run dev' },
    ]);
  });

  it('starts a project command, discovers its URL, and stops the process tree', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-preview-'));
    directories.push(directory);
    await fs.writeFile(path.join(directory, 'server.cjs'), [
      "console.log('Local: http://127.0.0.1:43719/');",
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');
    const runtime = new PreviewRuntime(path.join(directory, 'preview.cjs'));
    runtimes.push(runtime);
    const command = `"${process.execPath}" server.cjs`;

    await runtime.start('project-preview', directory, command);
    const state = await waitForState(runtime, 'project-preview', directory, 'running');
    expect(state.url).toBe('http://127.0.0.1:43719/');
    expect(state.outputTail).toContain('Local:');

    const stopped = await runtime.stop('project-preview', directory);
    expect(stopped.status).toBe('stopped');
    await expect(runtime.status('project-preview', directory)).resolves.toMatchObject({ status: 'stopped' });
  });
});

async function waitForState(runtime: PreviewRuntime, projectId: string, projectPath: string, status: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await runtime.status(projectId, projectPath);
    if (state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Preview did not reach ${status}.`);
}
