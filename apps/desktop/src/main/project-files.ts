import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, isGitRepo } from './checkpoints';

export const MAX_EDITABLE_BYTES = 1_000_000;
const MAX_TREE_FILES = 5_000;
const HIDDEN_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'release', '.next', '.cache', '__pycache__', '.venv', 'target']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.7z', '.rar', '.exe', '.dll',
  '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wav', '.class', '.jar', '.vsix', '.node', '.bin',
]);

export class FileConflictError extends Error {
  constructor(message = 'The file changed on disk after it was opened.') {
    super(message);
    this.name = 'FileConflictError';
  }
}

export interface ProjectFileEntry {
  path: string;
  size: number;
}

export interface OpenedFile {
  path: string;
  content: string;
  eol: 'lf' | 'crlf';
  bom: boolean;
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface WrittenFile {
  hash: string;
  mtimeMs: number;
  size: number;
}

const hashOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const posix = (value: string): string => value.split(path.sep).join('/');

/**
 * Resolve a project-relative path to an absolute one, refusing anything that could leave the project:
 * absolute paths, `..`, and symlinks (or junctions) whose target is outside the project root.
 */
export async function resolveInside(projectRoot: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes('\0')) throw new Error('A file path is required.');
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) throw new Error('Project paths must be relative.');
  const root = await fs.realpath(projectRoot);
  const target = path.resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error('That path is outside the project.');
  // Resolve links on the deepest part that already exists, so new files are checked through their parent folder.
  let existing = target;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      const rest = path.relative(existing, target);
      if (!isInside(root, path.resolve(real, rest))) throw new Error('That path leaves the project through a link.');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return target;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function looksBinaryBuffer(data: Buffer): boolean {
  const sample = data.subarray(0, 8_000);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}

export function detectEol(text: string): 'lf' | 'crlf' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? 'crlf' : 'lf';
}

function applyEol(text: string, eol: 'lf' | 'crlf'): string {
  const normalised = text.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? normalised.replace(/\n/g, '\r\n') : normalised;
}

async function gitVisibleFiles(root: string): Promise<string[] | null> {
  if (!(await isGitRepo(root))) return null;
  try {
    const output = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    return output.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function walkVisibleFiles(root: string, directory = '', found: string[] = []): Promise<string[]> {
  if (found.length >= MAX_TREE_FILES) return found;
  const entries = await fs.readdir(path.join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!HIDDEN_DIRECTORIES.has(entry.name)) await walkVisibleFiles(root, relative, found);
    } else if (entry.isFile()) {
      found.push(relative);
    }
  }
  return found;
}

/** Files worth showing in an editor: respects .gitignore in a repo, and hides large and binary files. */
export async function listProjectFiles(projectRoot: string): Promise<{ files: ProjectFileEntry[]; truncated: boolean }> {
  const root = await fs.realpath(projectRoot);
  const candidates = (await gitVisibleFiles(root)) ?? (await walkVisibleFiles(root));
  const files: ProjectFileEntry[] = [];
  for (const candidate of candidates) {
    if (files.length >= MAX_TREE_FILES) break;
    const relative = posix(candidate);
    if (relative.split('/').some((part) => HIDDEN_DIRECTORIES.has(part))) continue;
    if (BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    try {
      const stats = await fs.lstat(path.join(root, relative));
      if (!stats.isFile() || stats.size > MAX_EDITABLE_BYTES) continue;
      files.push({ path: relative, size: stats.size });
    } catch {
      // A file removed while listing is simply skipped.
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated: candidates.length > MAX_TREE_FILES };
}

export async function readProjectFile(projectRoot: string, relativePath: string): Promise<OpenedFile> {
  const target = await resolveInside(projectRoot, relativePath);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error('That path is not a file.');
  if (stats.size > MAX_EDITABLE_BYTES) throw new Error('This file is too large to edit here.');
  const data = await fs.readFile(target);
  if (looksBinaryBuffer(data)) throw new Error('Binary files cannot be edited here.');
  const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const text = data.subarray(bom ? 3 : 0).toString('utf8');
  return {
    path: posix(path.relative(await fs.realpath(projectRoot), target)),
    content: text,
    eol: detectEol(text),
    bom,
    hash: hashOf(data),
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

/**
 * Save an edit. `expectedHash` is the hash the editor loaded; if the file on disk no longer matches,
 * nothing is written and a FileConflictError is thrown. The original line endings and BOM are kept.
 */
export async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string,
  options: { expectedHash: string | null; eol: 'lf' | 'crlf'; bom: boolean },
): Promise<WrittenFile> {
  const target = await resolveInside(projectRoot, relativePath);
  let current: Buffer | null = null;
  try {
    current = await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current && options.expectedHash !== null && hashOf(current) !== options.expectedHash) throw new FileConflictError();
  if (!current && options.expectedHash !== null) throw new FileConflictError('The file was deleted on disk after it was opened.');
  const body = Buffer.from(applyEol(content, options.eol), 'utf8');
  const data = options.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (data.length > MAX_EDITABLE_BYTES) throw new Error('The edited file would be too large.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.kai-${process.pid}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, target);
  const stats = await fs.stat(target);
  return { hash: hashOf(data), mtimeMs: stats.mtimeMs, size: stats.size };
}

/** True when the file on disk no longer matches what the editor loaded. */
export async function fileChangedOnDisk(projectRoot: string, relativePath: string, expectedHash: string): Promise<boolean> {
  try {
    const target = await resolveInside(projectRoot, relativePath);
    return hashOf(await fs.readFile(target)) !== expectedHash;
  } catch {
    return true;
  }
}

/** Paths no context-menu action may touch. The editor is not a Git or project-root manager. */
function refusalFor(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return 'The project root cannot be changed here.';
  if (normalized === '.git' || normalized.startsWith('.git/')) return 'The Git folder cannot be changed from KAI.';
  return null;
}

/** Deletes a file or folder, with everything inside it. The caller confirms before this is reached. */
export async function deleteProjectPath(projectRoot: string, relativePath: string): Promise<void> {
  const refusal = refusalFor(relativePath);
  if (refusal) throw new Error(refusal);
  const root = await fs.realpath(projectRoot);
  const target = await resolveInside(projectRoot, relativePath);
  if (target === root) throw new Error('The project root cannot be deleted.');
  await fs.rm(target, { recursive: true, force: false });
}

/** Renames or moves a file or folder inside the project. The destination must not already exist. */
export async function renameProjectPath(projectRoot: string, from: string, to: string): Promise<void> {
  const refusal = refusalFor(from) ?? refusalFor(to);
  if (refusal) throw new Error(refusal);
  const root = await fs.realpath(projectRoot);
  const source = await resolveInside(projectRoot, from);
  const target = await resolveInside(projectRoot, to);
  if (source === root || target === root) throw new Error('The project root cannot be renamed.');
  await fs.access(source);
  try {
    await fs.access(target);
    throw new Error('Something already exists at that path.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.rename(source, target);
}

/** Creates a folder inside the project, including any missing parents. */
export async function createProjectFolder(projectRoot: string, relativePath: string): Promise<void> {
  const refusal = refusalFor(relativePath);
  if (refusal) throw new Error(refusal);
  const target = await resolveInside(projectRoot, relativePath);
  await fs.mkdir(target, { recursive: true });
}
