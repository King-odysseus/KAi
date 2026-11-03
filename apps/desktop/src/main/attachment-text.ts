import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { looksBinaryBuffer } from './project-files';

const run = promisify(execFile);
const MAX_TEXT = 200_000;

/** Extensions we can read as text even when the browser sent no useful MIME type. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.html', '.htm',
  '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.sql', '.graphql', '.gql',
]);

/**
 * The text an attached file contributes to the prompt. Text-like files are read directly; PDFs go through
 * `pdftotext` when it is installed (Git for Windows ships one). Anything else returns null, and the caller tells the
 * model where the file is instead of pretending to quote it.
 */
export async function attachmentText(filePath: string, name: string, mimeType?: string): Promise<string | null> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size > 25 * 1024 * 1024) return null;
  const extension = path.extname(name).toLowerCase();
  const textLike = Boolean(mimeType?.startsWith('text/'))
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || TEXT_EXTENSIONS.has(extension);
  if (textLike) {
    const data = await readFile(filePath).catch(() => null);
    if (!data || looksBinaryBuffer(data)) return null;
    return data.toString('utf8').slice(0, MAX_TEXT);
  }
  if (mimeType === 'application/pdf' || extension === '.pdf') return extractPdfText(filePath);
  return null;
}

async function extractPdfText(filePath: string): Promise<string | null> {
  const binary = findPdftotext();
  if (!binary) return null;
  try {
    const { stdout } = await run(binary, [filePath, '-'], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const text = String(stdout).trim();
    return text ? text.slice(0, MAX_TEXT) : null;
  } catch {
    return null;
  }
}

function findPdftotext(): string | null {
  const names = process.platform === 'win32' ? ['pdftotext.exe'] : ['pdftotext'];
  const pathRoots = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const common = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'mingw64', 'bin'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin'),
      ]
    : ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const directory of [...pathRoots, ...common]) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
