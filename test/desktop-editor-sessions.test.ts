import { describe, expect, it } from 'vitest';
import type { EditorDocumentState, WrittenFile } from '../packages/contracts/src';
import { EditorSessionManager } from '../apps/desktop/src/main/editor-sessions';

const projectId = 'project-1';
const documentPath = 'src/value.ts';

function document(content: string, dirty = true): EditorDocumentState {
  return {
    projectId,
    path: documentPath,
    content,
    savedContent: 'const value = 1;\n',
    expectedHash: 'hash-1',
    eol: 'lf',
    bom: false,
    dirty,
  };
}

describe('editor session manager', () => {
  it('restores the per-window document and layout snapshot', () => {
    const sessions = new EditorSessionManager();
    sessions.update(7, document('const value = 2;\n'));
    sessions.updateWindow(7, {
      projectId,
      documents: [],
      openPaths: [documentPath, documentPath],
      activePath: documentPath,
    });

    expect(sessions.snapshot(7, projectId)).toMatchObject({
      projectId,
      openPaths: [documentPath],
      activePath: documentPath,
      documents: [{ path: documentPath, content: 'const value = 2;\n', dirty: true }],
    });
    expect(sessions.snapshot(8, projectId).documents).toEqual([]);
    sessions.removeWindow(7);
    expect(sessions.snapshot(7, projectId).documents).toEqual([]);
  });

  it('does not mark a document clean when the renderer reports a newer edit during the write', async () => {
    let resolveWrite!: (written: WrittenFile) => void;
    const writePending = new Promise<WrittenFile>((resolve) => {
      resolveWrite = resolve;
    });
    const sessions = new EditorSessionManager(async () => writePending);
    sessions.update(1, document('const value = 2;\n'));

    const saving = sessions.saveDirty(1, new Map([[projectId, 'C:/project']]));
    sessions.update(1, document('const value = 3;\n'));
    resolveWrite({ hash: 'hash-2', mtimeMs: 10, size: 16 });

    await expect(saving).resolves.toEqual({
      saved: [],
      conflict: 'src/value.ts changed while KAI was saving it.',
    });
    expect(sessions.dirty(1)).toEqual([
      expect.objectContaining({ path: documentPath, content: 'const value = 3;\n', dirty: true }),
    ]);
  });

  it('keeps the first writer and rejects a stale same-file write from another window', async () => {
    let writeCount = 0;
    const sessions = new EditorSessionManager(async (_root, _path, content) => {
      writeCount += 1;
      if (writeCount > 1) throw new Error('File changed on disk since it was opened.');
      return { hash: `hash-${content.length}`, mtimeMs: 10, size: content.length };
    });
    sessions.update(1, document('const value = 2;\n'));
    sessions.update(2, document('const value = 3;\n'));
    const roots = new Map([[projectId, 'C:/project']]);

    const [first, second] = await Promise.all([
      sessions.saveDirty(1, roots),
      sessions.saveDirty(2, roots),
    ]);

    expect(first.conflict).toBeNull();
    expect(second.conflict).toContain('File changed on disk');
    expect(sessions.dirty(1)).toEqual([]);
    expect(sessions.dirty(2)).toEqual([expect.objectContaining({ content: 'const value = 3;\n' })]);
  });
});
