import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './checkpoints';

/**
 * The cheap, deterministic half of an audit: find credential-shaped values before the agent looks at anything.
 *
 * A model asked to "scan for secrets" will guess at plausible filenames and skim the files it happens to open.
 * This walks the files Git tracks (or the tree, when there is no repository), matches a small set of well-known
 * key shapes, and hands the agent the exact file and line. The agent is still the one who decides whether a match
 * is a real credential or a fixture — the pass produces leads, not findings.
 *
 * Only committed files are read, on purpose: an untracked `.env` is not a leak, while one Git would publish is.
 */

export interface SecurityPrepassResult {
  /** Facts to add to the audit prompt; always one short section. */
  text: string;
  filesScanned: number;
  secretsFound: number;
}

const MAX_FILES = 2_000;
const MAX_HITS = 50;
const MAX_BYTES = 300_000;
/** Whole-pass ceiling, so a repository of large text files cannot turn a scan into a disk read. */
const MAX_TOTAL_BYTES = 40_000_000;
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'out', 'dist', 'release', 'build', '.next', '.cache', 'coverage',
  '__pycache__', '.venv', 'venv', 'target', '.turbo', '.gradle',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wav',
  '.class', '.jar', '.vsix', '.node', '.bin', '.lock',
]);

interface SecretPattern {
  id: string;
  pattern: RegExp;
}

/** Shapes distinctive enough that the match itself is the lead. Run before the generic assignment pattern. */
const SPECIFIC_SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
];

/** Anything that looks assigned to a secret-sounding name. Noisy on its own, so it yields to a specific match. */
const ASSIGNED_SECRET_PATTERN: SecretPattern = {
  id: 'assigned secret',
  pattern: /(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*['"`]([^'"`\s]{12,})['"`]/gi,
};

export async function runSecurityPrepass(root: string): Promise<SecurityPrepassResult> {
  const candidates = await candidateFiles(root);
  const seen = new Set<string>();
  const hits: string[] = [];
  let scanned = 0;
  let bytesRead = 0;

  for (const relative of candidates) {
    if (scanned >= MAX_FILES || hits.length >= MAX_HITS || bytesRead >= MAX_TOTAL_BYTES) break;
    if (!looksTextual(relative)) continue;
    const absolute = path.join(root, relative);
    let size: number;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    bytesRead += content.length;
    const linesWithSpecificMatch = new Set<number>();
    for (const { id, pattern } of SPECIFIC_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(content); match && hits.length < MAX_HITS; match = pattern.exec(content)) {
        const line = lineAt(content, match.index);
        const key = `${relative}:${line}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        linesWithSpecificMatch.add(line);
        hits.push(`${relative}:${line} — ${id} ${redact(match[0])}`);
      }
    }
    // One lead per line: a value already named by its shape does not need the generic pattern saying so again.
    const generic = ASSIGNED_SECRET_PATTERN;
    generic.pattern.lastIndex = 0;
    for (let match = generic.pattern.exec(content); match && hits.length < MAX_HITS; match = generic.pattern.exec(content)) {
      const line = lineAt(content, match.index);
      if (linesWithSpecificMatch.has(line)) continue;
      const key = `${relative}:${line}:${generic.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(`${relative}:${line} — ${generic.id} ${redact(match[1] ?? match[0])}`);
    }
  }

  if (hits.length === 0) {
    return {
      text: `Deterministic pre-pass: scanned ${scanned} tracked text files and found no credential-shaped values.`,
      filesScanned: scanned,
      secretsFound: 0,
    };
  }
  return {
    text: [
      'Deterministic pre-pass (leads, not confirmed findings — verify each one):',
      ...hits.map((hit) => `- ${hit}`),
      'These are pattern matches. Open each file, confirm the value is a real credential rather than a placeholder, test fixture or example, and show only a redacted prefix in the evidence.',
    ].join('\n'),
    filesScanned: scanned,
    secretsFound: hits.length,
  };
}

/** Tracked files when there is a repository, the tree otherwise. Tracked means "could be published". */
async function candidateFiles(root: string): Promise<string[]> {
  try {
    const listed = await git(root, ['ls-files', '-z']);
    return listed.split('\0').filter(Boolean);
  } catch {
    const found: string[] = [];
    await walk(root, '', found);
    return found;
  }
}

async function walk(root: string, relative: string, found: string[]): Promise<void> {
  if (found.length >= MAX_FILES * 2) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(root, next, found);
    } else if (entry.isFile()) {
      found.push(next);
    }
  }
}

function looksTextual(relative: string): boolean {
  const base = path.basename(relative).toLowerCase();
  if (base.startsWith('.env') || base === 'dockerfile' || base === 'makefile') return true;
  const extension = path.extname(base);
  if (!extension) return true;
  return !BINARY_EXTENSIONS.has(extension);
}

/** 1-based line number for a character offset, without splitting the whole file for each match. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/** Enough of a match to find the line again, never enough to use the secret. */
function redact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '"[redacted]"';
  return `"${trimmed.slice(0, 4)}…[redacted]…${trimmed.slice(-2)}"`;
}
