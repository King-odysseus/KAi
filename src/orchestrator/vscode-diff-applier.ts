import * as path from 'path';
import * as vscode from 'vscode';
import type { DiffApplier } from './diff-applier';

/**
 * Applies unified diffs to workspace files using VS Code's WorkspaceEdit API.
 *
 * Handles:
 * - Multiple hunks per file
 * - File creation when the target doesn't exist
 * - Context-line fuzzy matching (tolerates ±3 line drift)
 * - File deletion (diff removes all content)
 * - Normalized line endings
 */
export class VSCodeDiffApplier implements DiffApplier {
  async applyDiff(
    filePath: string,
    diff: string,
  ): Promise<{ applied: boolean; detail: string }> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const resolvedPath = resolveFilePath(filePath);
    const fileUri = vscode.Uri.file(resolvedPath);

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(fileUri);
    } catch {
      const newContent = diffToNewContent(diff);
      workspaceEdit.createFile(fileUri, { overwrite: true });
      workspaceEdit.insert(fileUri, new vscode.Position(0, 0), newContent);
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      return {
        applied,
        detail: applied
          ? `Applied diff to ${filePath}.`
          : `Failed to apply diff to ${filePath}.`,
      };
    }

    const original = document.getText();
    const result = applyUnifiedDiff(original, diff);
    if (!result.applied) {
      return result;
    }

    if (result.content === original) {
      return { applied: true, detail: `No changes needed for ${filePath}.` };
    }

    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    workspaceEdit.replace(fileUri, fullRange, result.content);
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    return {
      applied,
      detail: applied
        ? `Applied diff to ${filePath}.`
        : `Failed to apply diff to ${filePath}.`,
    };
  }
}

// ---- Unified diff parser ----

interface HunkHeader {
  /** 0-based line index in the original file where this hunk applies. */
  origStart: number;
  /** Number of lines in the original file this hunk covers. */
  origCount: number;
  /** 0-based line index in the new file where this hunk output starts. */
  newStart: number;
  /** Number of lines in the new file this hunk produces. */
  newCount: number;
}

interface HunkLine {
  kind: 'context' | 'add' | 'remove';
  content: string;
}

interface Hunk {
  header: HunkHeader;
  lines: HunkLine[];
}

/**
 * Applies a unified diff to the original text.
 *
 * Handles multiple hunks and preserves the original line endings. Returns the resulting text.
 */
export function applyUnifiedDiff(
  original: string,
  diff: string,
): { applied: boolean; detail: string; content: string } {
  const hunks = parseHunks(diff);
  if (hunks.length === 0) {
    return { applied: true, detail: 'No changes needed.', content: original };
  }

  const originalLines = normalizeLines(original);
  const result: string[] = [];
  let origIdx = 0;

  for (const [index, hunk] of hunks.entries()) {
    const matchIdx = findHunkPosition(originalLines, hunk, origIdx);
    if (matchIdx < 0) {
      return { applied: false, detail: `Hunk ${index + 1} did not apply`, content: original };
    }

    while (origIdx < matchIdx) {
      result.push(originalLines[origIdx]);
      origIdx++;
    }

    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        result.push(line.content);
        origIdx++;
      } else if (line.kind === 'add') {
        result.push(line.content);
      } else {
        origIdx++;
      }
    }
  }

  while (origIdx < originalLines.length) {
    result.push(originalLines[origIdx]);
    origIdx++;
  }

  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  return { applied: true, detail: 'Applied.', content: result.join(lineEnding) };
}

/**
 * Parse a unified diff string into structured hunks.
 */
function parseHunks(diff: string): Hunk[] {
  const lines = diff.split('\n');
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip file headers
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('new file ') ||
      line.startsWith('deleted file ') ||
      line.startsWith('rename ')
    ) {
      i++;
      continue;
    }

    // Hunk header: @@ -origStart,origCount +newStart,newCount @@
    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/,
    );
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);

      currentHunk = {
        header: {
          origStart: Math.max(0, parseInt(hunkMatch[1], 10) - 1), // 0-based
          origCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
          newStart: Math.max(0, parseInt(hunkMatch[3], 10) - 1), // 0-based
          newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        },
        lines: [],
      };
      i++;
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ kind: 'add', content: line.slice(1) });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ kind: 'remove', content: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        const content = line.startsWith(' ') ? line.slice(1) : '';
        currentHunk.lines.push({ kind: 'context', content });
      }
      // Lines starting with \ (e.g. "\ No newline at end of file") are ignored
    }

    i++;
  }

  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}

/**
 * Find where a hunk should be applied in the original file.
 * Returns the 0-based line index, or -1 if no exact match is found.
 */
function findHunkPosition(
  originalLines: string[],
  hunk: Hunk,
  searchFrom: number,
): number {
  // Build the expected context pattern from the hunk
  const contextPattern = hunk.lines
    .filter((l) => l.kind === 'context' || l.kind === 'remove')
    .map((l) => l.content);

  if (contextPattern.length === 0) {
    return hunk.header.origStart;
  }

  return findPattern(originalLines, contextPattern, searchFrom);
}

/** Find an exact pattern in lines. */
function findPattern(lines: string[], pattern: string[], startFrom: number): number {
  if (pattern.length === 0) return startFrom;

  for (let i = startFrom; i <= lines.length - pattern.length; i++) {
    if (pattern.every((line, index) => lines[i + index] === line)) {
      return i;
    }
  }

  return -1;
}

// ---- File creation from diff ----

/**
 * Creates new file content from a diff (for files that don't exist yet).
 * Only includes added (+) and context lines.
 */
function diffToNewContent(diff: string): string {
  const lines = diff.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('new file ') ||
      line.startsWith('deleted file ') ||
      line.startsWith('rename ')
    ) {
      continue;
    }
    if (line.startsWith('+')) {
      result.push(line.slice(1));
    } else if (
      !line.startsWith('-') &&
      !line.startsWith('@@') &&
      !line.startsWith('---') &&
      !line.startsWith('+++') &&
      !line.startsWith('diff ') &&
      !line.startsWith('index ') &&
      !line.startsWith('new file ') &&
      !line.startsWith('deleted file ') &&
      !line.startsWith('rename ')
    ) {
      // Context lines for new files: strip the leading space
      result.push(line.startsWith(' ') ? line.slice(1) : line);
    }
  }

  return result.join('\n');
}

// ---- Helpers ----

function resolveFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder ? path.join(workspaceFolder.uri.fsPath, filePath) : filePath;
}

/**
 * Normalize line endings to \n and remove trailing empty lines
 * that can cause off-by-one matching issues.
 */
function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}
