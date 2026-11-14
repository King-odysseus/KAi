import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The `diagnostics` tool: the project's own compiler or linter errors, parsed instead of scraped from a shell run. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface DiagnosticsResult {
  ok: boolean;
  /** Which checker ran, or why none could. */
  source: string;
  total: number;
  diagnostics: Diagnostic[];
  truncated: boolean;
  note?: string;
}

const MAX_DIAGNOSTICS = 100;
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4_000_000;

// tsc --pretty false: path/file.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
// ruff --output-format concise: path/file.py:12:5: E501 Line too long
const RUFF_LINE = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.*)$/;
// mypy --show-column-numbers --no-error-summary: path/file.py:12:5: error: Message  [code]
const MYPY_LINE = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning):\s+(.*?)(?:\s+\[([\w-]+)\])?$/;
// cargo check --message-format short: src/main.rs:12:5: error[E0425]: cannot find value
const CARGO_LINE = /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[(\w+)\])?:\s+(.*)$/;
// go vet ./...: path/file.go:12:5: message
const GO_LINE = /^(?:vet: )?(.+?\.go):(\d+):(?:(\d+):)?\s+(.*)$/;

function relativeFile(file: string, root: string): string {
  return (path.isAbsolute(file) ? path.relative(root, file) : file).replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Parses `tsc --pretty false` output. A message's continuation lines (indented) are folded into it. */
export function parseTscOutput(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = TSC_LINE.exec(raw);
    if (match) {
      found.push({ file: relativeFile(match[1], root), line: Number(match[2]), column: Number(match[3]), severity: match[4] as 'error' | 'warning', code: match[5], message: match[6].trim() });
    } else if (/^\s+\S/.test(raw) && found.length > 0) {
      const last = found[found.length - 1];
      if (last.message.length < 600) last.message += ` ${raw.trim()}`;
    }
  }
  return found;
}

export function parseRuffOutput(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = RUFF_LINE.exec(raw);
    if (match) found.push({ file: relativeFile(match[1], root), line: Number(match[2]), column: Number(match[3]), severity: 'error', code: match[4], message: match[5].trim() });
  }
  return found;
}

export function parseMypyOutput(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = MYPY_LINE.exec(raw);
    if (match) found.push({ file: relativeFile(match[1], root), line: Number(match[2]), column: match[3] ? Number(match[3]) : 1, severity: match[4] as 'error' | 'warning', code: match[6] ?? 'mypy', message: match[5].trim() });
  }
  return found;
}

export function parseCargoOutput(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = CARGO_LINE.exec(raw);
    if (match) found.push({ file: relativeFile(match[1], root), line: Number(match[2]), column: Number(match[3]), severity: match[4] as 'error' | 'warning', code: match[5] ?? match[4], message: match[6].trim() });
  }
  return found;
}

export function parseGoOutput(output: string, root: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = GO_LINE.exec(raw);
    if (match) found.push({ file: relativeFile(match[1], root), line: Number(match[2]), column: match[3] ? Number(match[3]) : 1, severity: 'error', code: 'go vet', message: match[4].trim() });
  }
  return found;
}

export function filterDiagnostics(all: readonly Diagnostic[], onlyPath?: string): Diagnostic[] {
  const wanted = onlyPath?.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!wanted) return [...all];
  return all.filter((entry) => entry.file === wanted || entry.file.startsWith(`${wanted}/`));
}

/** The TypeScript compiler's script and the tsconfig to use, or undefined when the project has neither. */
export function findTypeScript(root: string): { script: string; tsconfig: string } | undefined {
  const tsconfig = ['tsconfig.json', 'tsconfig.app.json'].map((name) => path.join(root, name)).find((candidate) => fs.existsSync(candidate));
  if (!tsconfig) return undefined;
  const script = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  return fs.existsSync(script) ? { script, tsconfig } : undefined;
}

interface Checker {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  parse: (output: string, root: string) => Diagnostic[];
  /** A run whose output matches this means the tool itself is missing, so the next checker is tried. */
  absentWhen?: RegExp;
}

const PYTHON_ABSENT = /No module named|Python was not found/i;

/** The checkers that apply to this project, in the order they are tried. Each language stops at its first that runs. */
export function checkersFor(root: string): Checker[][] {
  const has = (name: string): boolean => fs.existsSync(path.join(root, name));
  const groups: Checker[][] = [];
  const ts = findTypeScript(root);
  if (ts) {
    groups.push([{ name: `tsc (${path.basename(ts.tsconfig)})`, command: process.execPath, args: [ts.script, '--noEmit', '--pretty', 'false', '-p', ts.tsconfig], env: { ELECTRON_RUN_AS_NODE: '1' }, parse: parseTscOutput }]);
  }
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt') || has('ruff.toml') || has('mypy.ini')) {
    const venvBin = ['.venv', 'venv'].map((dir) => path.join(root, dir, process.platform === 'win32' ? 'Scripts' : 'bin')).find((dir) => fs.existsSync(dir));
    const tool = (name: string): string => (venvBin ? path.join(venvBin, process.platform === 'win32' ? `${name}.exe` : name) : name);
    groups.push([
      { name: 'ruff', command: tool('ruff'), args: ['check', '--output-format', 'concise', '--no-fix'], parse: parseRuffOutput },
      { name: 'ruff', command: 'python', args: ['-m', 'ruff', 'check', '--output-format', 'concise', '--no-fix'], parse: parseRuffOutput, absentWhen: PYTHON_ABSENT },
      { name: 'mypy', command: tool('mypy'), args: ['--show-column-numbers', '--no-error-summary', '--no-color-output', '.'], parse: parseMypyOutput },
      { name: 'mypy', command: 'python', args: ['-m', 'mypy', '--show-column-numbers', '--no-error-summary', '--no-color-output', '.'], parse: parseMypyOutput, absentWhen: PYTHON_ABSENT },
    ]);
  }
  if (has('Cargo.toml')) groups.push([{ name: 'cargo check', command: 'cargo', args: ['check', '--message-format', 'short', '--quiet'], parse: parseCargoOutput }]);
  if (has('go.mod')) groups.push([{ name: 'go vet', command: 'go', args: ['vet', './...'], parse: parseGoOutput }]);
  return groups;
}

interface Ran { output: string; missing: boolean }

function runChecker(checker: Checker, root: string, signal?: AbortSignal): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    // No shell: nothing the model wrote is interpreted as a command.
    const child = spawn(checker.command, checker.args, { cwd: root, env: { ...process.env, ...checker.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let missing = false;
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const stop = (): void => { child.kill(); };
    signal?.addEventListener('abort', stop, { once: true });
    const append = (chunk: Buffer): void => { if (text.length < MAX_OUTPUT) text += chunk.toString('utf8'); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ output: text, missing: missing || Boolean(checker.absentWhen?.test(text)) }); };
    child.on('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') missing = true; done(); });
    child.on('close', done);
  });
}

export async function runTypeDiagnostics(root: string, options: { path?: string; signal?: AbortSignal } = {}): Promise<DiagnosticsResult> {
  const groups = checkersFor(root);
  if (groups.length === 0) {
    return { ok: false, source: 'none', total: 0, diagnostics: [], truncated: false, note: 'No supported checker was found for this project (TypeScript with node_modules/typescript, Python with ruff or mypy, Rust, or Go). Use run_command for the project\'s own check instead.' };
  }
  const all: Diagnostic[] = [];
  const sources: string[] = [];
  const unavailable: string[] = [];
  for (const group of groups) {
    let ran = false;
    for (const checker of group) {
      if (options.signal?.aborted) break;
      const result = await runChecker(checker, root, options.signal);
      if (result.missing) continue;
      all.push(...checker.parse(result.output, root));
      sources.push(checker.name);
      ran = true;
      break;
    }
    if (!ran) unavailable.push(group[0].name);
  }
  if (sources.length === 0) {
    return { ok: false, source: 'none', total: 0, diagnostics: [], truncated: false, note: `The checker for this project is not installed (${unavailable.join(', ')}). Use run_command for the project's own check instead.` };
  }
  const filtered = filterDiagnostics(all, options.path);
  const shown = filtered.slice(0, MAX_DIAGNOSTICS);
  const notes: string[] = [];
  if (filtered.length === 0) notes.push(options.path ? `No errors reported in ${options.path}.` : 'No errors reported.');
  if (unavailable.length > 0) notes.push(`Not checked (not installed): ${unavailable.join(', ')}.`);
  return {
    ok: true,
    source: sources.join(' + '),
    total: filtered.length,
    diagnostics: shown,
    truncated: filtered.length > shown.length,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}
