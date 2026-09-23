import path from 'node:path';
import * as fs from 'node:fs/promises';
import prettier from 'prettier';
import type { CodeFormatResult, GitFileInfo } from '@kai/contracts';
import { git, isGitRepo } from './checkpoints';
import { resolveInside } from './project-files';

export async function formatProjectCode(
  projectRoot: string,
  filePath: string,
  content: string,
): Promise<CodeFormatResult> {
  const target = await resolveInside(projectRoot, filePath);
  const fileInfo = await prettier.getFileInfo(target);
  const inferredParser = fileInfo.inferredParser;
  if (!inferredParser) throw new Error(`Prettier could not infer a parser for ${filePath}.`);
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
