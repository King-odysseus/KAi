import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_FILES = 1_500;
const MAX_FILE_BYTES = 200 * 1024;
const CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CHARACTERS = 8_000;
const SYMBOL_CAPS = [12, 6, 3, 0] as const;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.next', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'out', 'release', 'target', 'vendor',
]);

interface LanguageRule {
  extensions: readonly string[];
  patterns: readonly RegExp[];
}

const RULES: readonly LanguageRule[] = [
  {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    patterns: [
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
      /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      /^class\s+([A-Za-z_$][\w$]*)/,
    ],
  },
  { extensions: ['.py'], patterns: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/, /^class\s+([A-Za-z]\w*)/] },
  { extensions: ['.go'], patterns: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/, /^type\s+([A-Z]\w*)/] },
  {
    extensions: ['.rs'],
    patterns: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/],
  },
  {
    extensions: ['.java', '.kt', '.cs', '.swift'],
    patterns: [/^\s*(?:public\s+|internal\s+|open\s+)?(?:abstract\s+|final\s+|sealed\s+|static\s+|data\s+)*(?:class|interface|enum|record|struct|object|protocol)\s+([A-Za-z_]\w*)/],
  },
  { extensions: ['.rb'], patterns: [/^\s*(?:class|module|def)\s+([A-Za-z_]\w*[?!]?)/] },
  { extensions: ['.c', '.h', '.cpp', '.hpp', '.cc'], patterns: [/^(?:struct|class|enum)\s+([A-Za-z_]\w*)/] },
];

const RULE_BY_EXTENSION = new Map<string, LanguageRule>(RULES.flatMap((rule) => rule.extensions.map((extension) => [extension, rule] as const)));

export interface RepoMap {
  text: string;
  files: number;
  symbols: number;
  truncated: boolean;
}

export interface RepoMapOptions {
  maxCharacters?: number;
}

const cache = new Map<string, { at: number; map: RepoMap | null }>();

/** Drop the cached map for one project, or every project, so the next run sees fresh files. */
export function invalidateRepoMap(root?: string): void {
  if (root) cache.delete(path.resolve(root));
  else cache.clear();
}

/** Symbols a source file declares at its top level, in order, without duplicates. */
export function extractSymbols(relativePath: string, source: string): string[] {
  const rule = RULE_BY_EXTENSION.get(path.extname(relativePath).toLowerCase());
  if (!rule) return [];
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.length > 300) continue;
    for (const pattern of rule.patterns) {
      const name = pattern.exec(line)?.[1];
      if (name && !name.startsWith('_') && !seen.has(name)) {
        seen.add(name);
        symbols.push(name);
      }
      if (name) break;
    }
  }
  return symbols;
}

/**
 * A compact outline of the project: each source file with the names it declares. It lets an agent see where things
 * live without reading everything. Returns null when the folder has no source files to describe.
 */
export async function buildRepoMap(root: string, options: RepoMapOptions = {}): Promise<RepoMap | null> {
  const resolved = path.resolve(root);
  const cached = cache.get(resolved);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.map;
  const map = await computeRepoMap(resolved, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
  cache.set(resolved, { at: Date.now(), map });
  return map;
}

async function computeRepoMap(root: string, maxCharacters: number): Promise<RepoMap | null> {
  const listed = await listProjectFiles(root);
  const sourceFiles = listed.filter((file) => RULE_BY_EXTENSION.has(path.extname(file).toLowerCase())).sort();
  if (sourceFiles.length === 0) return null;

  const outline: Array<{ file: string; symbols: string[] }> = [];
  let filesRead = 0;
  for (const file of sourceFiles.slice(0, MAX_FILES)) {
    filesRead += 1;
    outline.push({ file, symbols: await readSymbols(root, file) });
  }

  const overflow = sourceFiles.length > MAX_FILES;
  for (const cap of SYMBOL_CAPS) {
    const lines = outline.map(({ file, symbols }) => renderLine(file, symbols, cap));
    const fitted = fit(lines, maxCharacters);
    if (fitted.fits || cap === 0) {
      const omitted = lines.length - fitted.lines.length;
      const notes = [
        overflow ? `${sourceFiles.length - MAX_FILES} more source files were not scanned.` : '',
        omitted > 0 ? `${omitted} more files omitted to keep this short. Use list_files or search_files to find them.` : '',
      ].filter(Boolean);
      return {
        text: [...fitted.lines, ...notes.map((note) => `(${note})`)].join('\n'),
        files: filesRead,
        symbols: outline.reduce((sum, item) => sum + item.symbols.length, 0),
        truncated: overflow || omitted > 0,
      };
    }
  }
  return null;
}

function renderLine(file: string, symbols: string[], cap: number): string {
  if (cap === 0 || symbols.length === 0) return file;
  const shown = symbols.slice(0, cap).join(', ');
  return `${file}: ${shown}${symbols.length > cap ? `, +${symbols.length - cap}` : ''}`;
}

function fit(lines: string[], maxCharacters: number): { fits: boolean; lines: string[] } {
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > maxCharacters) return { fits: false, lines: kept };
    used += line.length + 1;
    kept.push(line);
  }
  return { fits: true, lines: kept };
}

async function readSymbols(root: string, file: string): Promise<string[]> {
  try {
    const target = path.join(root, file);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    return extractSymbols(file, await fs.readFile(target, 'utf8'));
  } catch {
    return [];
  }
}

async function listProjectFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
    });
    const files = stdout.split('\0').filter(Boolean);
    if (files.length > 0) return [...new Set(files)].filter((file) => !hasIgnoredSegment(file));
  } catch {
    // Not a Git repository (or Git is missing): walk the folder instead.
  }
  return walk(root);
}

function hasIgnoredSegment(file: string): boolean {
  return file.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0 && files.length < MAX_FILES * 4) {
    const relativeDirectory = pending.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return files;
}
