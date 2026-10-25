import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStylesheet, listStylesheets, stylesheetVerdict } from '../apps/desktop/src/main/stylesheet-guard';

describe('what counts as a stylesheet', () => {
  it('counts the plain and preprocessor forms, including CSS modules', () => {
    expect(isStylesheet('styles.css')).toBe(true);
    expect(isStylesheet('button.module.css')).toBe(true);
    expect(isStylesheet('theme.scss')).toBe(true);
    expect(isStylesheet('legacy.less')).toBe(true);
  });

  it('leaves markup, scripts and the built app alone', () => {
    expect(isStylesheet('App.tsx')).toBe(false);
    expect(isStylesheet('index.html')).toBe(false);
    expect(isStylesheet('styles.css.map')).toBe(false);
  });
});

describe('the one stylesheet rule, as a check', () => {
  it('says nothing about a card that added no stylesheet', () => {
    expect(stylesheetVerdict(['src/styles.css'], ['src/styles.css']).message).toBe('');
  });

  it('lets a project with no stylesheet create exactly one, and no more', () => {
    expect(stylesheetVerdict([], ['src/styles.css']).message).toBe('');
    const tooMany = stylesheetVerdict([], ['src/styles.css', 'src/button.css']);
    expect(tooMany.message).toContain('may create exactly one');
    expect(tooMany.message).toContain('src/button.css');
  });

  it('sends back a card that adds a stylesheet beside the project’s own', () => {
    const verdict = stylesheetVerdict(['src/styles.css'], ['src/styles.css', 'src/pages/Settings.css']);
    expect(verdict.added).toEqual(['src/pages/Settings.css']);
    // The message names the file to keep, so the next attempt knows where the styles belong.
    expect(verdict.message).toContain('src/styles.css');
    expect(verdict.message).toContain('src/pages/Settings.css');
  });

  it('does not judge a project that already had a stylesheet convention of its own', () => {
    // CSS modules, a theme folder: the rule tells the agent to follow the convention rather than collapse it.
    const verdict = stylesheetVerdict(['a.module.css', 'b.module.css'], ['a.module.css', 'b.module.css', 'c.module.css']);
    expect(verdict.enforced).toBe(false);
    expect(verdict.message).toBe('');
  });

  it('is not fooled by a stylesheet that was renamed rather than added', () => {
    const verdict = stylesheetVerdict(['src/old.css'], ['src/new.css']);
    expect(verdict.message).toContain('src/new.css');
  });
});

describe('listing a project’s stylesheets', () => {
  it('walks the project, skips dependencies and build output, and gives paths to compare across runs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-stylesheets-'));
    await fs.mkdir(path.join(root, 'src', 'pages'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'flowbite'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'styles.css'), 'body {}');
    await fs.writeFile(path.join(root, 'src', 'pages', 'Home.module.css'), '.a {}');
    await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export {}');
    await fs.writeFile(path.join(root, 'node_modules', 'flowbite', 'flowbite.css'), '.x {}');
    await fs.writeFile(path.join(root, 'dist', 'app.css'), '.y {}');

    expect(await listStylesheets(root)).toEqual(['src/pages/Home.module.css', 'src/styles.css']);
  });

  it('treats a folder it cannot read as holding nothing, so the check never invents a violation', async () => {
    expect(await listStylesheets(path.join(os.tmpdir(), 'kai-does-not-exist-at-all'))).toEqual([]);
  });
});
