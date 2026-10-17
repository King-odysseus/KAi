import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../apps/desktop/src/main/context-builder';

const roots: string[] = [];

function projectWithRules(rules: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kai-path-rules-'));
  roots.push(root);
  mkdirSync(path.join(root, '.kai', 'rules'), { recursive: true });
  for (const [name, content] of Object.entries(rules)) {
    writeFileSync(path.join(root, '.kai', 'rules', name), content, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('path-scoped rules', () => {
  it('loads a rule only when a touched path matches its applyTo globs', async () => {
    const root = projectWithRules({
      'source.md': '---\napplyTo: src/**\n---\nUse the project error helper.',
      'docs.md': '---\napplyTo: docs/**\n---\nWrite examples in plain language.',
    });

    const matched = await buildProjectContext(root, { touchedPaths: ['src/app.ts'] });
    expect(matched.text).toContain('Use the project error helper.');
    expect(matched.text).not.toContain('Write examples in plain language.');

    const other = await buildProjectContext(root, { touchedPaths: ['docs/guide.md'] });
    expect(other.text).toContain('Write examples in plain language.');
    expect(other.text).not.toContain('Use the project error helper.');
  });

  it('loads nothing when no path was touched', async () => {
    const root = projectWithRules({ 'source.md': '---\napplyTo: src/**\n---\nUse the helper.' });
    const built = await buildProjectContext(root);
    expect(built.text).not.toContain('Use the helper.');
  });

  it('treats a star rule as always applicable and ignores files without frontmatter', async () => {
    const root = projectWithRules({
      'always.md': '---\napplyTo: "*"\n---\nPrefer small commits.',
      'plain.md': 'This file has no frontmatter.',
    });
    const built = await buildProjectContext(root, { touchedPaths: ['anything.ts'] });
    expect(built.text).toContain('Prefer small commits.');
    expect(built.text).not.toContain('This file has no frontmatter.');
  });

  it('leaves path rules out of a resumed session, like the other static instructions', async () => {
    const root = projectWithRules({ 'source.md': '---\napplyTo: src/**\n---\nUse the helper.' });
    const built = await buildProjectContext(root, { touchedPaths: ['src/app.ts'], omitStatic: true });
    expect(built.text).not.toContain('Use the helper.');
  });
});
