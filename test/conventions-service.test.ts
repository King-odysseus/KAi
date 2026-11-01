import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConventionService, buildBriefing } from '../src/cognitive1/conventions-service';
import type { ConventionItem, ConventionsState } from '../src/cognitive1/conventions-service';

const item = (source: ConventionItem['source'], text: string, muted = false): ConventionItem =>
  ({ key: `${source}:${text}`, source, text, evidence: 'x', projects: [], muted, isNew: false });

interface Setup {
  service: ConventionService;
  notes: Array<{ title: string; description: string; tags: string[] }>;
  changes: ConventionsState[];
  add(name: string, files: Record<string, string>): Promise<string>;
  failLearning(): void;
}

async function withService(run: (setup: Setup) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-ext-conv-service-'));
  let serviceRef: ConventionService | null = null;
  try {
    const folders: string[] = [];
    const notes: Setup['notes'] = [];
    const changes: ConventionsState[] = [];
    let failing = false;
    const service = new ConventionService(path.join(dir, 'store', 'conventions.json'), {
      projectFolders: async () => folders,
      learn: async (note) => { if (failing) throw new Error('C1 is stopped'); notes.push(note); return 'saved'; },
      onChange: (state) => { changes.push(state); },
    });
    serviceRef = service;
    await run({
      service, notes, changes,
      add: async (name, files) => {
        const root = path.join(dir, 'projects', name);
        for (const [file, text] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await fs.writeFile(path.join(root, file), text);
        }
        folders.push(root);
        return root;
      },
      failLearning: () => { failing = true; },
    });
  } finally {
    await serviceRef?.idle();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const REACT = JSON.stringify({ dependencies: { react: '1', tailwindcss: '1' } });
const NICE_CARDS = Array.from({ length: 6 }, () => '<div className="card rounded-xl shadow-md p-4">x</div>').join('\n');

describe('extension conventions briefing', () => {
  it('lists rules first, then style, then the stack, and leaves out anything muted', () => {
    const lines = buildBriefing([item('habit', 'React'), item('rule', 'Never use hairline borders'), item('style', 'Cards use no border'), item('habit', 'Muted', true)]).split('\n');
    expect(lines.slice(1)).toEqual(['- Never use hairline borders', '- Cards use no border', '- React']);
    expect(buildBriefing([])).toBe('');
  });
});

describe('extension convention service', () => {
  it('serves nothing before a scan, then the habits found across your projects', async () => {
    await withService(async ({ service, add }) => {
      expect(service.briefing()).toBe('');
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      expect(service.briefing()).toContain('React');
      expect(service.briefing()).toContain('2 of 2 of your projects');
    });
  });

  it('serves the look of a reference project even though only one project shows it', async () => {
    await withService(async ({ service, add }) => {
      const lofts = await add('zurilofts', { 'src/Home.tsx': NICE_CARDS });
      await add('other', { 'package.json': '{}' });
      await service.setReference(lofts, true);
      await service.refresh();
      expect(service.briefing()).toContain('Cards use rounded corners (xl), no border, a soft shadow (as in zurilofts)');
      await service.setReference(lofts, false);
      await service.refresh();
      expect(service.briefing()).not.toContain('zurilofts');
    });
  });

  it('serves a rule at once, stops when it is removed, and honours a mute', async () => {
    await withService(async ({ service, add }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      const withRule = await service.addRule('Use Lucide icons, not emoji');
      expect(service.briefing()).toContain('- Use Lucide icons, not emoji');
      await service.removeRule(withRule.rules[0]!.id);
      expect(service.briefing()).not.toContain('Lucide');
      await service.setMuted('habit:react', true);
      expect(service.briefing()).not.toContain('React');
      await service.setMuted('habit:react', false);
      expect(service.briefing()).toContain('React');
    });
  });

  it('flags a habit that turns up on a later scan as new, but not the first list', async () => {
    await withService(async ({ service, add }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      expect((await service.state()).items.some((entry) => entry.isNew)).toBe(false);
      await add('gamma', { 'package.json': JSON.stringify({ dependencies: { vue: '1' } }) });
      await add('delta', { 'package.json': JSON.stringify({ dependencies: { vue: '1' } }) });
      await service.refresh();
      expect((await service.state()).items.find((entry) => entry.key === 'habit:vue')?.isNew).toBe(true);
      await service.markSeen();
      expect((await service.state()).items.find((entry) => entry.key === 'habit:vue')?.isNew).toBe(false);
    });
  });

  it('files what it serves into C1 once, files it again when the wording changes, and keeps going if C1 is down', async () => {
    await withService(async ({ service, add, notes, failLearning }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      const first = notes.length;
      expect(first).toBeGreaterThanOrEqual(2);
      expect(notes[0]?.tags).toContain('convention');
      await service.refresh();
      expect(notes.length).toBe(first);
      await add('gamma', { 'package.json': REACT });
      await service.refresh();
      expect(notes.length).toBeGreaterThan(first);
      failLearning();
      await service.addRule('A rule while C1 is down');
      expect(service.briefing()).toContain('A rule while C1 is down');
    });
  });

  it('picks up a project added while a scan is already running', async () => {
    await withService(async ({ service, add }) => {
      void service.briefing();
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      expect(service.briefing()).toContain('React');
    });
  });

  it('keeps its choices across a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-ext-conv-persist-'));
    try {
      const file = path.join(dir, 'conventions.json');
      const ports = { projectFolders: async () => [] as string[], learn: async () => 'ok' };
      const first = new ConventionService(file, ports);
      await first.addRule('Keep it simple');
      await first.setMuted('habit:react', true);
      await first.idle();
      const second = new ConventionService(file, ports);
      const state = await second.state();
      expect(state.rules.map((rule) => rule.text)).toEqual(['Keep it simple']);
      expect(second.briefing()).toContain('Keep it simple');
      await second.idle();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
