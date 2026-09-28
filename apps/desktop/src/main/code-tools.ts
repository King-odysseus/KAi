import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import prettier from 'prettier';
import type { CodeFormatResult, GitFileInfo } from '@kai/contracts';
import { git, isGitRepo } from './checkpoints';
import { resolveInside } from './project-files';

const FORMAT_TIMEOUT_MS = 20_000;
const MAX_FORMAT_OUTPUT = 4 * 1024 * 1024;

interface ExternalFormatter {
  /** Shown to the learner, for example "Ruff". */
  name: string;
  command: string;
  args: (target: string) => string[];
  /** Also look for the tool in the project's own virtual environment before PATH. */
  venv?: boolean;
  /** A failure whose message matches this means the tool is absent (for example "No module named ruff"). */
  absentWhen?: RegExp;
}

// pip on Windows often installs tools where PATH cannot see them, so Python formatters are also run as modules.
const PYTHON_ABSENT = /No module named|Python was not found/i;

/** Languages Prettier does not cover, each with the formatters tried in order. */
const EXTERNAL_FORMATTERS: ReadonlyArray<{ extensions: readonly string[]; language: string; formatters: readonly ExternalFormatter[] }> = [
  {
    extensions: ['.py', '.pyi'],
    language: 'Python',
    formatters: [
      { name: 'Ruff', command: 'ruff', args: (target) => ['format', '--stdin-filename', target, '-'], venv: true },
      { name: 'Black', command: 'black', args: (target) => ['--quiet', '--stdin-filename', target, '-'], venv: true },
      { name: 'Ruff', command: 'python', args: (target) => ['-m', 'ruff', 'format', '--stdin-filename', target, '-'], venv: true, absentWhen: PYTHON_ABSENT },
      { name: 'Black', command: 'python', args: (target) => ['-m', 'black', '--quiet', '--stdin-filename', target, '-'], venv: true, absentWhen: PYTHON_ABSENT },
    ],
  },
  { extensions: ['.go'], language: 'Go', formatters: [{ name: 'gofmt', command: 'gofmt', args: () => [] }] },
  { extensions: ['.rs'], language: 'Rust', formatters: [{ name: 'rustfmt', command: 'rustfmt', args: () => ['--emit', 'stdout', '--edition', '2021'] }] },
  {
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.m', '.mm', '.java', '.proto'],
    language: 'C, C++, Java and Protobuf',
    formatters: [{ name: 'clang-format', command: 'clang-format', args: (target) => [`--assume-filename=${target}`] }],
  },
];

type FormatterRun = { status: 'ok'; output: string } | { status: 'missing' } | { status: 'failed'; message: string };

function runFormatter(command: string, args: string[], input: string, cwd: string): Promise<FormatterRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ status: 'missing' });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: FormatterRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: 'failed', message: `${command} took longer than ${FORMAT_TIMEOUT_MS / 1000} seconds.` });
    }, FORMAT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORMAT_OUTPUT) {
        child.kill();
        finish({ status: 'failed', message: `${command} returned more output than expected.` });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' || error.code === 'EACCES' ? { status: 'missing' } : { status: 'failed', message: error.message });
    });
    child.on('close', (code) => {
      if (code === 0) finish({ status: 'ok', output: Buffer.concat(stdout).toString('utf8') });
      else finish({ status: 'failed', message: Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).slice(0, 6).join('\n') || `${command} exited with code ${code}.` });
    });
    // A formatter that exits before reading everything closes stdin early; its exit code reports the real problem.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input, 'utf8');
  });
}

/** The project's own copy of a tool (.venv or venv) first, then whatever PATH finds. */
async function formatterCandidates(projectRoot: string, formatter: ExternalFormatter): Promise<string[]> {
  const candidates: string[] = [];
  if (formatter.venv) {
    for (const environment of ['.venv', 'venv']) {
      const executable = process.platform === 'win32'
        ? path.join(projectRoot, environment, 'Scripts', `${formatter.command}.exe`)
        : path.join(projectRoot, environment, 'bin', formatter.command);
      if (await fs.access(executable).then(() => true, () => false)) candidates.push(executable);
    }
  }
  candidates.push(formatter.command);
  return candidates;
}

export async function formatProjectCode(
  projectRoot: string,
  filePath: string,
  content: string,
): Promise<CodeFormatResult> {
  const target = await resolveInside(projectRoot, filePath);
  const extension = path.extname(target).toLowerCase();
  const external = EXTERNAL_FORMATTERS.find((entry) => entry.extensions.includes(extension));
  if (external) {
    for (const formatter of external.formatters) {
      for (const command of await formatterCandidates(projectRoot, formatter)) {
        const run = await runFormatter(command, formatter.args(target), content, projectRoot);
        if (run.status === 'missing' || (run.status === 'failed' && formatter.absentWhen?.test(run.message))) continue;
        if (run.status === 'failed') throw new Error(`${formatter.name} could not format ${filePath}: ${run.message}`);
        // Tools on Windows may write CRLF; keep the editor's own line endings so only real formatting counts.
        const lf = run.output.replace(/\r\n/g, '\n');
        const formatted = content.includes('\r\n') ? lf.replace(/\n/g, '\r\n') : lf;
        return { formatted, changed: formatted !== content, parser: formatter.name };
      }
    }
    const names = [...new Set(external.formatters.map((formatter) => formatter.name))].join(' or ');
    return {
      formatted: content,
      changed: false,
      parser: '',
      skipped: { reason: `Install ${names} to format ${external.language} files.`, missingTool: true },
    };
  }
  const fileInfo = await prettier.getFileInfo(target);
  const inferredParser = fileInfo.inferredParser;
  if (!inferredParser) {
    return { formatted: content, changed: false, parser: '', skipped: { reason: `KAI has no formatter for ${extension || 'these'} files.`, missingTool: false } };
  }
  const config = await prettier.resolveConfig(target, { editorconfig: true });
  const formatted = await prettier.format(content, {
    ...config,
    filepath: target,
    parser: inferredParser,
  });
  return {
    formatted,
    changed: formatted !== content,
    parser: inferredParser,
  };
}

export async function projectGitFileInfo(projectRoot: string, filePath: string): Promise<GitFileInfo> {
  if (!(await isGitRepo(projectRoot))) {
    return { isRepository: false, status: 'not-a-repository', entries: [] };
  }
  const safePath = await resolveInside(projectRoot, filePath);
  const resolvedRoot = await fs.realpath(projectRoot);
  const relative = path.relative(resolvedRoot, safePath).split(path.sep).join('/');
  const statusOutput = await git(projectRoot, ['status', '--porcelain=v1', '--', relative]);
  const status = statusOutput.trim().split(/\r?\n/, 1)[0]?.slice(0, 2).trim() || 'clean';
  const logOutput = await git(projectRoot, [
    'log',
    '-n',
    '20',
    '--follow',
    '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
    '--',
    relative,
  ]).catch(() => '');
  const entries = logOutput
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', author = '', date = '', ...subjectParts] = record.split('\x1f');
      return { hash, shortHash, author, date, subject: subjectParts.join('\x1f') };
    })
    .filter((entry) => entry.hash && entry.shortHash);
  return { isRepository: true, status, entries };
}
