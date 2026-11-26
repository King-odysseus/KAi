import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConventionItem, ConventionsState } from '@kai/contracts';
import { NodeFileSystem } from '../packages/runtime/src';
import { ConventionService, buildBriefing } from '../apps/desktop/src/main/conventions-service';

const item = (source: ConventionItem['source'], text: string, muted = false): ConventionItem =>
  ({ key: `${source}:${text}`, source, text, evidence: 'x', projects: [], muted, isNew: false });

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

interface Setup {
  dir: string;
  service: ConventionService;
  sent: Array<Record<string, unknown>>;
  changes: ConventionsState[];
  add(name: string, files: Record<string, string>): Promise<string>;
  setLearn(handler: (payload: Record<string, unknown>) => unknown): void;
}

async function withService(run: (setup: Setup) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-conv-service-'));
  let serviceRef: ConventionService | null = null;
  try {
    const projects: Array<{ id: string; name: string; path: string }> = [];
    const sent: Array<Record<string, unknown>> = [];
    const changes: ConventionsState[] = [];
    let learn: (payload: Record<string, unknown>) => unknown = (payload) => ({ ok: true, entry: { title: payload.title, date: '2026-11-20' } });
    const service = new ConventionService(path.join(dir, 'conventions.json'), new NodeFileSystem(), {
      projects: async () => projects,
      learn: async (payload) => { sent.push(payload); return learn(payload); },
      onChange: (state) => { changes.push(state); },
    });
    serviceRef = service;
    await run({
      dir, service, sent, changes,
      add: async (name, files) => {
        const root = path.join(dir, 'projects', name);
        for (const [file, text] of Object.entries(files)) await write(path.join(root, file), text);
        projects.push({ id: name, name, path: root });
        return root;
      },
      setLearn: (handler) => { learn = handler; },
    });
  } finally {
    await serviceRef?.idle();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const REACT = JSON.stringify({ dependencies: { react: '1', tailwindcss: '1' } });
const NICE_CARDS = Array.from({ length: 6 }, () => '<div className="card rounded-xl shadow-md p-4">x</div>').join('\n');

describe('conventions briefing', () => {
  it('lists your rules first, then the stack, then style, and leaves out anything muted', () => {
    const text = buildBriefing([item('habit', 'React for the interface'), item('rule', 'Never use hairline borders'), item('style', 'Cards use no border'), item('habit', 'Muted one', true)]);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Follow these');
    expect(lines.slice(1)).toEqual(['- Never use hairline borders', '- React for the interface', '- Cards use no border']);
  });

  it('is empty when there is nothing to say, and short when there is a lot', () => {
    expect(buildBriefing([])).toBe('');
    expect(buildBriefing([item('habit', 'x', true)])).toBe('');
    const many = Array.from({ length: 40 }, (_, index) => item('habit', `Habit number ${index} ${'word '.repeat(20)}`));
    const text = buildBriefing(many);
    expect(text.split('\n').length).toBeLessThanOrEqual(13);
    expect(text.length).toBeLessThanOrEqual(1_800);
  });
});

describe('convention service', () => {
  it('serves nothing before a scan, then the habits found across your projects', async () => {
    await withService(async ({ service, add }) => {
      expect(service.briefing()).toBe('');
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      const briefing = service.briefing();
      expect(briefing).toContain('React');
      expect(briefing).toContain('Tailwind');
      expect(briefing).toContain('2 of 2 of your projects');
    });
  });

  it('serves the look of a reference project even though only one project shows it', async () => {
    await withService(async ({ service, add }) => {
      const lofts = await add('zurilofts', { 'src/Home.tsx': NICE_CARDS });
      await add('other', { 'package.json': '{}' });
      await service.setReference(lofts, true);
      await service.refresh();
      const briefing = service.briefing();
      expect(briefing).toContain('Cards use rounded corners (xl), a soft shadow (as in zurilofts)');
      // Without a reference the same project proves nothing, because a habit needs more than one project.
      await service.setReference(lofts, false);
      await service.refresh();
      expect(service.briefing()).not.toContain('zurilofts');
    });
  });

  it('keeps reference styles scoped to their project and serves only agreement elsewhere', async () => {
    await withService(async ({ service, add }) => {
      const pillRules = Array.from({ length: 3 }, (_, index) => `.btn-${index} { border-radius: 9999px; }`).join('\n');
      const squareRules = Array.from({ length: 3 }, (_, index) => `.btn-${index} { border-radius: 4px; }`).join('\n');
      const pillProject = await add('pill', { 'src/buttons.css': pillRules });
      const squareProject = await add('square', { 'src/buttons.css': squareRules });
      const unrelated = await add('unrelated', { 'package.json': '{}' });
      await service.setReference(pillProject, true);
      await service.setReference(squareProject, true);
      await service.refresh();
      expect(service.briefing(pillProject)).toContain('Buttons use fully rounded corners (as in pill)');
      expect(service.briefing(pillProject)).not.toContain('square');
      expect(service.briefing(squareProject)).toContain('Buttons use rounded corners (4px) (as in square)');
      expect(service.briefing(unrelated)).not.toContain('Buttons use');
    });
  });

  it('serves a rule you write at once, and stops when you remove it', async () => {
    await withService(async ({ service }) => {
      const state = await service.addRule('Never use 1px hairline borders');
      expect(service.briefing()).toContain('- Never use 1px hairline borders');
      await service.removeRule(state.rules[0]!.id);
      expect(service.briefing()).toBe('');
    });
  });

  it('stops serving what you mute and serves it again when you turn it back on', async () => {
    await withService(async ({ service, add }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      const react = (await service.state()).items.find((entry) => entry.key === 'habit:react')!;
      await service.setMuted(react.key, true);
      expect(service.briefing()).not.toContain('React');
      expect((await service.state()).items.find((entry) => entry.key === react.key)?.muted).toBe(true);
      await service.setMuted(react.key, false);
      expect(service.briefing()).toContain('React');
    });
  });

  it('flags a habit that appears on a later scan as new, and not the first list', async () => {
    await withService(async ({ service, add }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      expect((await service.state()).items.some((entry) => entry.isNew)).toBe(false);
      await add('gamma', { 'package.json': JSON.stringify({ dependencies: { vue: '1' } }) });
      await add('delta', { 'package.json': JSON.stringify({ dependencies: { vue: '1' } }) });
      await service.refresh();
      const vue = (await service.state()).items.find((entry) => entry.key === 'habit:vue');
      expect(vue?.isNew).toBe(true);
      await service.markSeen();
      expect((await service.state()).items.find((entry) => entry.key === 'habit:vue')?.isNew).toBe(false);
    });
  });

  it('files what it serves into C1 once, files it again when the wording changes, and keeps going if C1 is down', async () => {
    await withService(async ({ service, add, sent, setLearn }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await service.refresh();
      const first = sent.length;
      expect(first).toBeGreaterThanOrEqual(2);
      expect(String(sent[0]?.tags)).toContain('convention');
      expect(sent[0]).toMatchObject({ type: 'patterns', project: 'global' });
      await service.refresh();
      expect(sent.length).toBe(first);
      // A third project changes the counts, so the wording changes and C1 hears about it.
      await add('gamma', { 'package.json': REACT });
      await service.refresh();
      expect(sent.length).toBeGreaterThan(first);
      // C1 down: nothing is lost and the list still works.
      setLearn(() => { throw new Error('C1 is stopped'); });
      await service.addRule('Use Lucide icons, not emoji');
      expect(service.briefing()).toContain('Lucide');
      expect((await service.state()).filedInC1).toBeGreaterThan(0);
    });
  });

  it('supersedes the prior C1 note when a detected convention changes, recording ambiguous outcomes', async () => {
    await withService(async ({ service, add, sent, setLearn, dir }) => {
      const root = await add('cards', { 'src/Cards.tsx': NICE_CARDS });
      await service.setReference(root, true);
      await service.refresh();
      const prior = sent.find((payload) => String(payload.title).startsWith('Convention: Cards'))!;
      await write(path.join(root, 'src/Cards.tsx'), Array.from({ length: 6 }, () => '<div className="card rounded-sm shadow-md p-4">x</div>').join('\n'));
      setLearn(() => ({ ok: true, entry: { title: 'Convention: updated cards', date: '2026-11-26' }, supersedeOutcome: 'ambiguous' }));
      await service.refresh();
      const update = sent.find((payload) => payload.supersede_title !== undefined);
      expect(update).toMatchObject({ supersede_date: '2026-11-20', supersede_title: prior?.title });
      const state = JSON.parse(await fs.readFile(path.join(dir, 'conventions.json'), 'utf8')) as { filed: Record<string, { supersedeOutcome?: string }> };
      expect(Object.values(state.filed).some((entry) => entry.supersedeOutcome === 'ambiguous')).toBe(true);
      const sentAfterAmbiguity = sent.length;
      await service.refresh();
      expect(sent).toHaveLength(sentAfterAmbiguity);
    });
  });

  it('files a retirement note when a convention disappears', async () => {
    await withService(async ({ service, sent }) => {
      const created = await service.addRule('Use stable semantic button names');
      await service.refresh();
      await service.idle();
      const original = sent.find((payload) => payload.title === 'Convention: Use stable semantic button names')!;
      await service.removeRule(created.rules[0]!.id);
      await service.refresh();
      await service.idle();
      const retirement = sent.find((payload) => String(payload.title).startsWith('Convention retired:'));
      expect(retirement).toMatchObject({ supersede_date: '2026-11-20', supersede_title: original?.title });
      expect(retirement?.how).toBe('Do not apply the retired convention.');
    });
  });

  it('shares one scan between callers, and tells the screen when the list changes', async () => {
    await withService(async ({ service, add, changes }) => {
      await add('alpha', { 'package.json': REACT });
      await add('beta', { 'package.json': REACT });
      await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
      const afterScan = changes.length;
      expect(afterScan).toBeGreaterThan(0);
      await service.addRule('A rule');
      expect(changes.length).toBeGreaterThan(afterScan);
      expect(changes.at(-1)?.rules).toHaveLength(1);
    });
  });
});
