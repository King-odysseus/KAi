import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProfile, conventionDraft, conventionsFor, detect, scanProjects, snapshotProject } from '../apps/desktop/src/main/conventions-scan';
import type { ProjectSnapshot } from '../apps/desktop/src/main/conventions-scan';

function project(name: string, patch: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { name, files: [], dependencies: [], manifestText: '', sourceText: '', ...patch };
}

const AT = '2026-11-01T10:00:00.000Z';

describe('conventions detection', () => {
  it('reads the stack from dependencies, manifests and file names', () => {
    expect(detect(project('a', { dependencies: ['react', 'tailwindcss', 'lucide-react'] }))).toEqual(['react', 'tailwind', 'lucide']);
    expect(detect(project('b', { files: ['manage.py', 'api/mpesa/stk.py'], manifestText: 'django==5\npytest' }))).toEqual(expect.arrayContaining(['django', 'mpesa', 'pytest']));
    expect(detect(project('c', { files: ['Dockerfile', '.github/workflows/ci.yml'] }))).toEqual(['docker', 'github-actions']);
  });

  it('finds nothing in an empty project', () => {
    expect(detect(project('empty'))).toEqual([]);
  });
});

describe('conventions profile', () => {
  const projects = [
    project('tijha', { dependencies: ['react', 'tailwindcss'], files: ['src/App.tsx'] }),
    project('zuri', { dependencies: ['react', 'tailwindcss', 'stripe'], files: ['src/App.tsx'] }),
    project('lofts', { files: ['manage.py', 'payments/mpesa.py'], manifestText: 'django' }),
  ];

  it('keeps a pattern only when at least two projects show it', () => {
    const profile = buildProfile(projects, AT);
    const keys = profile.conventions.map((convention) => convention.key);
    expect(keys).toEqual(expect.arrayContaining(['react', 'tailwind', 'src-folder']));
    // One project each: examples, not habits.
    expect(keys).not.toContain('stripe');
    expect(keys).not.toContain('django');
    expect(keys).not.toContain('mpesa');
    expect(profile.conventions.find((convention) => convention.key === 'react')).toMatchObject({ count: 2, total: 3, projects: ['tijha', 'zuri'] });
  });

  it('asks for a third of the projects once there are more than three', () => {
    const many = [...projects, project('d'), project('e'), project('f'), project('g')];
    // react is in 2 of 7: under a third, so not a convention yet.
    expect(buildProfile(many, AT).conventions.find((convention) => convention.key === 'react')).toBeUndefined();
  });

  it('says how often payments are done a given way, once it is a habit', () => {
    const payments = buildProfile([
      project('a', { sourceText: 'await mpesa.stkpush(phone)' }),
      project('b', { files: ['lib/mpesa.ts'] }),
      project('c', { dependencies: ['stripe'] }),
    ], AT);
    expect(payments.conventions.find((convention) => convention.key === 'mpesa')).toMatchObject({ count: 2, total: 3 });
  });
});

describe('conventions for a goal', () => {
  const profile = buildProfile([
    project('a', { dependencies: ['react', 'tailwindcss'], sourceText: 'mpesa stk push', files: ['src/x.ts'] }),
    project('b', { dependencies: ['react', 'tailwindcss'], sourceText: 'mpesa stk push', files: ['src/x.ts'] }),
    project('c', { dependencies: ['vitest'], files: ['Dockerfile'] }),
    project('d', { dependencies: ['vitest'], files: ['Dockerfile'] }),
  ], AT);

  it('brings in conventions a goal mentions and the stack that applies to nearly any build', () => {
    const lines = conventionsFor(profile, 'Build checkout with M-Pesa payment');
    expect(lines.join('\n')).toContain('M-Pesa');
    expect(lines.join('\n')).toContain('React');
    expect(lines.every((line) => line.includes('of your projects'))).toBe(true);
  });

  it('leaves out what the goal does not touch and caps the list', () => {
    expect(conventionsFor(profile, 'Write the README').join('\n')).not.toContain('Docker');
    expect(conventionsFor(profile, 'payment ui test deploy structure', 2)).toHaveLength(2);
  });

  it('returns nothing when there is no profile to draw on', () => {
    expect(conventionsFor(buildProfile([], AT), 'anything')).toEqual([]);
  });

  it('writes a draft for the review queue with its evidence and no claim it is settled', () => {
    const draft = conventionDraft(profile.conventions[0]!, AT);
    expect(draft.tags).toContain('convention');
    expect(draft.body).toContain('Evidence:');
    expect(draft.body).toContain('2026-11-01');
  });
});

describe('reading a folder', () => {
  it('snapshots a project without reading node_modules and survives a missing folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-conv-'));
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules', 'big'), { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '1' }, devDependencies: { vitest: '1' } }));
      await fs.writeFile(path.join(root, 'src', 'pay.ts'), 'export const x = "MPESA";');
      await fs.writeFile(path.join(root, 'node_modules', 'big', 'index.js'), 'stripe');
      const snapshot = await snapshotProject(root, 'demo');
      expect(snapshot.dependencies).toEqual(['react', 'vitest']);
      expect(snapshot.files).toContain('src/pay.ts');
      expect(snapshot.files.some((file) => file.startsWith('node_modules'))).toBe(false);
      expect(snapshot.sourceText).toContain('mpesa');
      const profile = await scanProjects([root, path.join(root, 'does-not-exist')], AT);
      expect(profile.total).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
