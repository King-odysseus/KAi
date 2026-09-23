import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { AutonomyMode, PermissionKey } from '@kai/contracts';

const MAX_READ_BYTES = 512 * 1024;
const MAX_READ_LINES = 400;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_TEXT = 100_000;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_COMMAND_OUTPUT = 200_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);

const readFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  })
  .strict();

const searchFilesInputSchema = z
  .object({
    query: z.string().min(1).max(200),
    path: z.string().min(1).max(1_024).optional(),
    max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

const replaceInFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    old_text: z.string().min(1).max(MAX_EDIT_TEXT),
    new_text: z.string().max(MAX_EDIT_TEXT),
    replace_all: z.boolean().optional(),
  })
  .strict();

const createFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    content: z.string().max(MAX_EDIT_TEXT),
  })
  .strict();

const runCommandInputSchema = z
  .object({
    command: z.string().trim().min(1).max(MAX_COMMAND_LENGTH),
    cwd: z.string().min(1).max(1_024).optional(),
    timeout_ms: z.number().int().min(100).max(MAX_COMMAND_TIMEOUT_MS).optional(),
  })
  .strict();

export const projectToolDefinitions = [
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the active project. Paths are relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        start_line: { type: 'integer', minimum: 1, description: 'Optional first line to return (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Optional last line to return (1-based).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_files',
    description: 'Search text files inside the active project for a literal, case-insensitive string.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to search for.' },
        path: { type: 'string', description: 'Optional project-relative file or directory to search.' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'replace_in_file',
    description: 'Replace exact text in an existing project file. Use this for code changes instead of rewriting a whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        old_text: { type: 'string', description: 'Exact existing text to replace.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every exact occurrence when true; otherwise require one occurrence.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_file',
    description: 'Create a new UTF-8 text file inside the active project. Existing files are never overwritten.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path for the new file.' },
        content: { type: 'string', description: 'Initial file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_command',
    description: 'Run a shell command in the active project. Commands use your user permissions and may access resources outside the project, so approval is required outside Full mode.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Optional working directory relative to the project root.' },
        timeout_ms: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          description: 'Optional timeout in milliseconds. Defaults to 30000 and cannot exceed 120000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

export type ProjectToolName = (typeof projectToolDefinitions)[number]['name'];

export interface ProjectToolExecution {
  ok: boolean;
  output: unknown;
  changedFile?: {
    path: string;
    action: 'edited' | 'created';
    summary: string;
  };
}

export type ProjectToolPolicy =
  | { decision: 'allow' }
  | { decision: 'ask'; title: string; detail: string; risk: 'low' | 'medium' | 'high' }
  | { decision: 'deny'; reason: string };

export interface ExternalToolPort {
  definitions(): Promise<readonly unknown[]>;
  policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy | undefined;
  execute(name: string, input: unknown, signal?: AbortSignal): Promise<ProjectToolExecution | undefined>;
}

export class DesktopProjectToolRuntime {
  private resolvedRoot: Promise<string> | undefined;

  constructor(
    private readonly root: string,
    private readonly customPermissions: Partial<Record<PermissionKey, boolean>> = {},
  ) {}

  policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy {
    if (name === 'read_file' || name === 'search_files') return { decision: 'allow' };
    if (name === 'run_command') {
      if (autonomy === 'plan') {
        return { decision: 'deny', reason: 'Plan mode does not allow shell commands.' };
      }
      if (autonomy === 'full') return { decision: 'allow' };
      if (autonomy === 'custom' && this.customPermissions.shellCommand) return { decision: 'allow' };
      return {
        decision: 'ask',
        title: 'Run a project command?',
        detail: 'Commands run with your user permissions and can access resources outside the project. Review the exact command and working directory before allowing it.',
        risk: 'high',
      };
    }
    if (name !== 'replace_in_file' && name !== 'create_file') {
      return { decision: 'deny', reason: `Unknown project tool: ${name}.` };
    }
    if (autonomy === 'plan') {
      return { decision: 'deny', reason: `The current plan mode does not allow ${name}.` };
    }
    if (autonomy === 'autoEdit' || autonomy === 'full') return { decision: 'allow' };
    if (autonomy === 'custom' && this.customPermissions.workspaceEdit) return { decision: 'allow' };
    return {
      decision: 'ask',
      title: name === 'create_file' ? 'Create a project file?' : 'Edit a project file?',
      detail: 'The model requested a project file change. Review the tool arguments before allowing it.',
      risk: 'medium',
    };
  }

  async execute(name: string, rawInput: unknown, signal?: AbortSignal): Promise<ProjectToolExecution> {
    try {
      if (name === 'read_file') return await this.readFile(readFileInputSchema.parse(rawInput));
      if (name === 'search_files') return await this.searchFiles(searchFilesInputSchema.parse(rawInput));
      if (name === 'replace_in_file') return await this.replaceInFile(replaceInFileInputSchema.parse(rawInput));
      if (name === 'create_file') return await this.createFile(createFileInputSchema.parse(rawInput));
      if (name === 'run_command') return await this.runCommand(runCommandInputSchema.parse(rawInput), signal);
      return toolFailure(`Unknown project tool: ${name}.`);
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : String(error));
    }
  }

  private async readFile(input: z.infer<typeof readFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`${input.path} is ${stat.size} bytes; the read limit is ${MAX_READ_BYTES} bytes.`);
    }
    const content = await fs.readFile(target, 'utf8');
    if (looksBinary(content)) throw new Error(`${input.path} does not appear to be a UTF-8 text file.`);
    const lines = content.split(/\r?\n/);
    const start = input.start_line ?? 1;
    const requestedEnd = input.end_line ?? Math.min(lines.length, start + MAX_READ_LINES - 1);
    const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1, lines.length);
    if (start > lines.length) {
      return { ok: true, output: { path: normalizeRelative(input.path), startLine: start, endLine: start - 1, totalLines: lines.length, text: '' } };
    }
    const selected = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    return {
      ok: true,
      output: {
        path: normalizeRelative(input.path),
        startLine: start,
        endLine: Math.max(start, end),
        totalLines: lines.length,
        text: selected,
        truncated: end < lines.length,
      },
    };
  }

  private async searchFiles(input: z.infer<typeof searchFilesInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path ?? '.', true);
    const stat = await fs.stat(target);
    const maxResults = input.max_results ?? 20;
    const needle = input.query.toLocaleLowerCase();
    const files = stat.isDirectory() ? await this.collectTextFiles(target) : [target];
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;
      const fileStat = await fs.stat(file);
      if (fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(content)) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (lines[index].toLocaleLowerCase().includes(needle)) {
          matches.push({
            path: normalizeRelative(path.relative(await this.projectRoot(), file)),
            line: index + 1,
            text: lines[index].slice(0, 500),
          });
        }
      }
    }

    return {
      ok: true,
      output: {
        query: input.query,
        matches,
        truncated: matches.length >= maxResults,
      },
    };
  }

  private async replaceInFile(input: z.infer<typeof replaceInFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_EDIT_FILE_BYTES) throw new Error(`${input.path} is too large to edit safely.`);
    const content = await fs.readFile(target, 'utf8');
    const occurrences = countOccurrences(content, input.old_text);
    if (occurrences === 0) throw new Error(`The exact old_text was not found in ${input.path}.`);
    if (!input.replace_all && occurrences !== 1) {
      throw new Error(`The exact old_text occurs ${occurrences} times in ${input.path}; make it unique or set replace_all.`);
    }
    const next = input.replace_all
      ? content.split(input.old_text).join(input.new_text)
      : content.replace(input.old_text, input.new_text);
    await fs.writeFile(target, next, 'utf8');
    return {
      ok: true,
      output: {
        path: normalizeRelative(input.path),
        replacements: input.replace_all ? occurrences : 1,
        occurrences,
      },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'edited',
        summary: `Replaced ${input.replace_all ? occurrences : 1} occurrence(s) in ${input.path}.`,
      },
    };
  }

  private async createFile(input: z.infer<typeof createFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, false);
    try {
      await fs.writeFile(target, input.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`${input.path} already exists. Use replace_in_file for an existing file.`);
      }
      throw error;
    }
    return {
      ok: true,
      output: { path: normalizeRelative(input.path), created: true, bytes: Buffer.byteLength(input.content, 'utf8') },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'created',
        summary: `Created ${input.path}.`,
      },
    };
  }

  private async runCommand(input: z.infer<typeof runCommandInputSchema>, signal?: AbortSignal): Promise<ProjectToolExecution> {
    if (signal?.aborted) return commandFailure('Command was cancelled before it started.', '', '', undefined);
    const cwd = await this.resolveInsideProject(input.cwd ?? '.', true);
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) throw new Error(`${input.cwd ?? '.'} is not a directory.`);

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let cancellationRequested = false;
    let timeoutRequested = false;
    let timeout: NodeJS.Timeout | undefined;
    const child = spawn(input.command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = (): void => {
      cancellationRequested = true;
      void terminateProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendLimited(stdout, chunk.toString('utf8'), MAX_COMMAND_OUTPUT);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendLimited(stderr, chunk.toString('utf8'), MAX_COMMAND_OUTPUT);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signalName) => resolve({ code, signal: signalName }));
    });
    timeout = setTimeout(() => {
      timeoutRequested = true;
      void terminateProcessTree(child);
    }, input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS);

    try {
      const result = await closed;
      const output = {
        exitCode: result.code,
        signal: result.signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
      };
      if (cancellationRequested) return commandFailure('Command was cancelled.', stdout, stderr, output);
      if (timeoutRequested) {
        return { ok: false, output: { ...output, timedOut: true, error: `Command timed out after ${input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS}ms.` } };
      }
      return { ok: result.code === 0, output };
    } catch (error) {
      if (cancellationRequested) return commandFailure('Command was cancelled.', stdout, stderr, undefined);
      if (timeoutRequested) return commandFailure(`Command timed out after ${input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS}ms.`, stdout, stderr, undefined);
      return commandFailure(error instanceof Error ? error.message : String(error), stdout, stderr, undefined);
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async collectTextFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [root];
    while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
      const directory = pending.pop();
      if (!directory) break;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_SEARCH_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  private async resolveInsideProject(requestedPath: string, mustExist: boolean): Promise<string> {
    const root = await this.projectRoot();
    const candidate = path.resolve(root, requestedPath);
    assertInside(root, candidate, requestedPath);

    if (mustExist) {
      const resolved = await fs.realpath(candidate);
      assertInside(root, resolved, requestedPath);
      return resolved;
    }

    let existingParent = path.dirname(candidate);
    while (true) {
      try {
        const resolvedParent = await fs.realpath(existingParent);
        assertInside(root, resolvedParent, requestedPath);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const next = path.dirname(existingParent);
        if (next === existingParent) throw new Error(`No existing parent directory was found for ${requestedPath}.`);
        existingParent = next;
      }
    }
    return candidate;
  }

  private projectRoot(): Promise<string> {
    this.resolvedRoot ??= fs.realpath(this.root).then(async (root) => {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error('The active project is not a directory.');
      return root;
    });
    return this.resolvedRoot;
  }
}

function assertInside(root: string, candidate: string, requestedPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the active project: ${requestedPath}.`);
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 1_000);
  timer.unref();
}

function appendLimited(current: string, appended: string, limit: number): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: Boolean(appended) };
  const remaining = limit - current.length;
  if (appended.length <= remaining) return { value: current + appended, truncated: false };
  return { value: current + appended.slice(0, remaining), truncated: true };
}

function commandFailure(
  message: string,
  stdout: string,
  stderr: string,
  output: Record<string, unknown> | undefined,
): ProjectToolExecution {
  return {
    ok: false,
    output: {
      ...(output ?? { stdout, stderr }),
      error: message,
    },
  };
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

function looksBinary(content: string): boolean {
  return content.slice(0, 4_096).includes('\u0000');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

function normalizeRelative(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function toolFailure(message: string): ProjectToolExecution {
  return { ok: false, output: { error: message } };
}
