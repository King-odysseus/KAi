import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editorSettingsSchema } from '../packages/contracts/src';
import { fileIconId, folderIconId } from '../apps/desktop/src/renderer/src/file-icons';
import { pushRecent } from '../apps/desktop/src/renderer/src/recent-files';
import { blameLabel, editorViewOptions, relativeAge } from '../apps/desktop/src/renderer/src/editor-view';
import { ICON_Base, ICON_FileExtensions, ICON_FileNames, ICON_FolderNames } from '../apps/desktop/src/renderer/src/file-icons.generated';
import { gitBlameFile, hunksFromDiff, scanTodos } from '../apps/desktop/src/main/git-tools';

const iconDir = join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'public', 'file-icons');

describe('file type icons', () => {
  it('picks an icon by exact name, then by the longest extension, then a plain file', () => {
    expect(fileIconId('package.json')).toBe(ICON_FileNames['package.json']);
    expect(fileIconId('App.TSX')).toBe(ICON_FileExtensions['tsx']);
    expect(fileIconId('app.test.ts')).toBe(ICON_FileExtensions['test.ts']);
    expect(fileIconId('app.test.ts')).not.toBe(fileIconId('app.ts'));
    expect(fileIconId('mystery.zzzzqq')).toBe(ICON_Base.file);
  });

  it('gives KAI files their own icons ahead of the theme', () => {
    expect(fileIconId('CLAUDE.md')).toBe('claude');
    expect(folderIconId('.kai', false)).toBe('folder-robot');
    expect(folderIconId('.kai', true)).toBe('folder-robot-open');
  });

  it('uses the open artwork for an open folder and the base folder for an unknown one', () => {
    expect(folderIconId('src', false)).toBe(ICON_FolderNames['src']);
    expect(folderIconId('src', true)).toBe(`${ICON_FolderNames['src']}-open`);
    expect(folderIconId('zzz-unknown', false)).toBe(ICON_Base.folder);
    expect(folderIconId('zzz-unknown', true)).toBe(ICON_Base.folderOpen);
  });

  it('ships an SVG for every icon it can return', () => {
    const ids = new Set<string>([
      ...Object.values(ICON_FileNames), ...Object.values(ICON_FileExtensions), ...Object.values(ICON_FolderNames),
      'claude', 'robot', 'gemini-ai', 'skill', 'console', 'document', 'folder-robot', 'folder-robot-open', 'folder-claude-open', 'folder-tasks-open', 'folder-docs-open',
      ...Object.values(ICON_Base),
    ]);
    const missing = [...ids].filter((id) => !existsSync(join(iconDir, `${id}.svg`)));
    expect(missing).toEqual([]);
  });
});

describe('editor view', () => {
  const on = editorSettingsSchema.parse({});

  it('defaults to the helpers on, except the minimap and wrapping', () => {
    expect(on.bracketColors && on.guides && on.stickyScroll && on.errorLens && on.gitBlame && on.fileIcons).toBe(true);
    expect(on.minimap).toBe(false);
    expect(on.wordWrap).toBe(false);
  });

  it('maps each switch onto the Monaco option it controls', () => {
    const options = editorViewOptions(on);
    expect(options.bracketPairColorization).toMatchObject({ enabled: true });
    expect(options.stickyScroll).toEqual({ enabled: true });
    expect(options.wordWrap).toBe('off');
    const off = editorViewOptions({ ...on, bracketColors: false, guides: false, minimap: true, wordWrap: true });
    expect(off.bracketPairColorization).toMatchObject({ enabled: false });
    expect(off.guides).toMatchObject({ indentation: false, bracketPairs: false });
    expect(off.minimap).toEqual({ enabled: true });
    expect(off.wordWrap).toBe('on');
  });

  it('words blame the way GitLens does', () => {
    const now = Date.UTC(2026, 10, 7) ;
    expect(relativeAge(now / 1000 - 3 * 86_400, now)).toBe('3 days ago');
    expect(relativeAge(now / 1000, now)).toBe('just now');
    expect(blameLabel({ commit: 'abc12345', author: 'Nate', time: now / 1000 - 86_400, summary: 'Fix tree' }, now)).toBe('Nate, 1 day ago • Fix tree');
    expect(blameLabel({ author: 'x', time: 0, summary: '' })).toBe('Not committed yet');
    expect(blameLabel(undefined)).toBeNull();
  });

  it('reads blame for a real file, and nothing for one Git does not know', async () => {
    const root = join(__dirname, '..');
    const blame = await gitBlameFile(root, 'package.json');
    expect(blame.lines.length).toBeGreaterThan(5);
    expect(blame.lines[0]).toMatchObject({ author: expect.any(String), time: expect.any(Number) });
    expect((await gitBlameFile(root, 'no-such-file.xyz')).lines).toEqual([]);
  }, 60_000);
});

describe('change bars, recent files and to-dos', () => {
  it('turns a unified diff into added, modified and deleted ranges of the new file', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,6 +1,7 @@', ' keep', '-old', '+new', '+newer', ' keep', '+brand new', ' keep', '-gone', ' tail'].join('\n');
    expect(hunksFromDiff(diff)).toEqual([
      { start: 2, count: 2, kind: 'modified' },
      { start: 5, count: 1, kind: 'added' },
      { start: 7, count: 0, kind: 'deleted' },
    ]);
    expect(hunksFromDiff('')).toEqual([]);
  });

  it('keeps the recent list newest first, unique and capped', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'z', 2)).toEqual(['z', 'a']);
  });

  it('finds to-do comments in a project, and ignores the word outside a comment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kai-todos-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      await writeFile(join(root, 'a.ts'), ['const x = 1; // TODO: tidy this', 'const todo = "TODO list";', '/* FIXME later */'].join('\n'));
      await writeFile(join(root, 'b.py'), '# NOTE keep in sync\n');
      const found = await scanTodos(root);
      expect(found.truncated).toBe(false);
      expect(found.items.map((item) => `${item.path}:${item.line}:${item.kind}:${item.text}`).sort()).toEqual([
        'a.ts:1:TODO:tidy this', 'a.ts:3:FIXME:later', 'b.py:1:NOTE:keep in sync',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
