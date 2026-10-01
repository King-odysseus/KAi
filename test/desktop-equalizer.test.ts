import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { countDifferences, equalizerRunInputSchema, inferTarget, parsePages } from '../packages/contracts/src';
import {
  checkDesignOnly,
  colourDistance,
  compareFacts,
  DesktopEqualizer,
  diffImages,
  parseColour,
  parsePageFacts,
  pixelSeverity,
  reportMarkdown,
  toHex,
  type EqualizerPorts,
  type FactElement,
  type PageFacts,
} from '../apps/desktop/src/main/equalizer';

function element(over: Partial<FactElement> = {}): FactElement {
  return { tag: 'h1', role: '', text: 'Dashboard', x: 24, y: 24, w: 300, h: 36, color: 'rgb(230, 237, 243)', background: 'rgba(0, 0, 0, 0)', fontSize: '24px', fontWeight: '600', fontFamily: 'Inter', radius: '0px', padding: '0px 0px 0px 0px', gap: '0px', ...over };
}

function facts(elements: FactElement[], scrollHeight = 900): PageFacts {
  return { url: 'http://x', width: 1280, height: 900, scrollHeight, elements };
}

function solid(width: number, height: number, [r, g, b]: [number, number, number], paint?: (png: PNG) => void): Buffer {
  const png = new PNG({ width, height });
  for (let index = 0; index < width * height; index += 1) {
    png.data[index * 4] = r;
    png.data[index * 4 + 1] = g;
    png.data[index * 4 + 2] = b;
    png.data[index * 4 + 3] = 255;
  }
  paint?.(png);
  return PNG.sync.write(png);
}

describe('colours', () => {
  it('reads CSS colours and measures how far apart two are', () => {
    expect(parseColour('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColour('rgba(10, 20, 30, 0.5)')?.a).toBe(0.5);
    expect(parseColour('red')).toBeNull();
    expect(colourDistance('rgb(0, 0, 0)', 'rgb(0, 0, 0)')).toBe(0);
    expect(colourDistance('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeGreaterThan(400);
    expect(colourDistance('rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0)')).toBe(0);
    expect(toHex('rgb(62, 230, 182)')).toBe('#3EE6B6');
  });
});

describe('comparing what two pages say', () => {
  it('reports nothing when the pages agree', () => {
    expect(compareFacts(facts([element()]), facts([element()]))).toEqual([]);
  });

  it('finds the same heading in a different place and says what differs about it', () => {
    const live = facts([element({ x: 300, y: 200, fontSize: '18px', color: 'rgb(204, 204, 204)', fontWeight: '400' })]);
    const found = compareFacts(facts([element()]), live);
    const kinds = found.map((difference) => difference.kind).sort();
    expect(kinds).toEqual(['colour', 'position', 'typography', 'typography']);
    expect(found.find((difference) => difference.id.startsWith('font-size'))).toMatchObject({ severity: 'high', expected: '24px', actual: '18px' });
    expect(found.find((difference) => difference.kind === 'colour')?.message).toContain('#E6EDF3');
  });

  it('matches elements by their text, so a moved button is compared with itself', () => {
    const reference = facts([element({ tag: 'button', text: 'Save', w: 80, h: 32, radius: '8px', background: 'rgb(62, 230, 182)' }), element({ tag: 'button', text: 'Cancel', x: 200 })]);
    const live = facts([element({ tag: 'button', text: 'Cancel', x: 200 }), element({ tag: 'button', text: 'Save', w: 80, h: 32, radius: '2px', background: 'rgb(62, 230, 182)', x: 24 })]);
    const found = compareFacts(reference, live);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'radius', expected: '8px', actual: '2px' });
  });

  it('reports a heading that is missing from the live page as high, and an extra one as low', () => {
    const found = compareFacts(facts([element({ text: 'Recent chats' })]), facts([element({ text: 'Settings' })]));
    expect(found.find((difference) => difference.id.startsWith('missing'))).toMatchObject({ severity: 'high', kind: 'content' });
    expect(found.find((difference) => difference.id.startsWith('extra'))).toMatchObject({ severity: 'low' });
  });

  it('ignores small differences and sorts the worst first', () => {
    const live = facts([element({ fontSize: '24.5px', x: 30, color: 'rgb(231, 236, 243)' }), element({ text: 'Other', tag: 'h2', fontSize: '10px' })]);
    const reference = facts([element(), element({ text: 'Other', tag: 'h2', fontSize: '20px' })]);
    const found = compareFacts(reference, live);
    expect(found.map((difference) => difference.kind)).toEqual(['typography']);
    expect(found[0]?.severity).toBe('high');
  });

  it('notices a page that is much taller or shorter', () => {
    expect(compareFacts(facts([], 1000), facts([], 600)).map((difference) => difference.id)).toEqual(['page-height']);
    expect(compareFacts(facts([], 1000), facts([], 950))).toEqual([]);
  });

  it('reads the probe output back out of an MCP text block', () => {
    const parsed = parsePageFacts(`### Result\n${JSON.stringify(facts([element()]))}\n`);
    expect(parsed?.elements).toHaveLength(1);
    expect(parsePageFacts('no json here')).toBeNull();
    expect(parsePageFacts('{"nothing": true}')).toBeNull();
  });
});

describe('comparing pictures', () => {
  it('finds identical pictures identical', () => {
    const result = diffImages(solid(40, 30, [10, 20, 30]), solid(40, 30, [10, 20, 30]));
    expect(result.ratio).toBe(0);
    expect(result.sizeMismatch).toBeNull();
    expect(pixelSeverity(result.ratio)).toBeNull();
  });

  it('measures how much of the picture differs, and returns a picture of where', () => {
    const changed = solid(40, 30, [10, 20, 30], (png) => {
      for (let y = 0; y < 15; y += 1) for (let x = 0; x < 40; x += 1) png.data[(y * 40 + x) * 4] = 250;
    });
    const result = diffImages(solid(40, 30, [10, 20, 30]), changed);
    expect(result.ratio).toBeCloseTo(0.5, 1);
    expect(pixelSeverity(result.ratio)).toBe('high');
    expect(PNG.sync.read(result.difference).width).toBe(40);
  });

  it('compares the part two pictures share when their sizes differ, and says so', () => {
    const result = diffImages(solid(40, 30, [1, 2, 3]), solid(50, 20, [1, 2, 3]));
    expect(result.sizeMismatch).toEqual({ reference: { width: 40, height: 30 }, live: { width: 50, height: 20 } });
    expect(result.width).toBe(40);
    expect(result.height).toBe(20);
    expect(result.ratio).toBe(0);
  });

  it('treats under a percent as noise and grades the rest', () => {
    expect(pixelSeverity(0.004)).toBeNull();
    expect(pixelSeverity(0.02)).toBe('low');
    expect(pixelSeverity(0.1)).toBe('medium');
    expect(pixelSeverity(0.3)).toBe('high');
  });
});

describe('the design-only check', () => {
  const pages = parsePages('# Pages\n\n## Sign-in\n/sign-in\n\n## Dashboard\nNo route here.\n\n## Settings\n/settings\n');

  it('flags a screen that is listed but not drawn, one that has no route, and one drawn but not listed', () => {
    const { screens } = checkDesignOnly(pages, ['sign-in', 'Dashboard', 'Admin console']);
    const byName = (name: string) => screens.find((screen) => screen.name === name)!;
    expect(byName('Sign-in').status).toBe('match');
    expect(byName('Dashboard').differences.map((difference) => difference.id)).toEqual(['no-route']);
    expect(byName('Settings').status).toBe('not-drawn');
    expect(byName('Settings').differences[0]).toMatchObject({ severity: 'high', kind: 'screen' });
    expect(byName('Admin console').status).toBe('not-listed');
  });

  it('says so when there is no pages list at all', () => {
    expect(checkDesignOnly([], []).notes[0]).toMatch(/no pages list/);
  });
});

describe('choosing the target from what the user wrote', () => {
  it('reads dev, production and design wordings, and gives up when unclear', () => {
    expect(inferTarget('the dashboard on my app does not match the design')).toBe('dev');
    expect(inferTarget('Dev looks wrong around the cards')).toBe('dev');
    expect(inferTarget('production does not match')).toBe('production');
    expect(inferTarget('the live site is off')).toBe('production');
    expect(inferTarget('I just did the design, check it')).toBe('design');
    expect(inferTarget('make it look better')).toBeNull();
  });
});

// --- The runner, against fakes -----------------------------------------------------------------------------

function fakePorts(over: Partial<EqualizerPorts> = {}): { ports: EqualizerPorts; written: Map<string, string | Buffer>; opened: string[] } {
  const written = new Map<string, string | Buffer>();
  const opened: string[] = [];
  const files = new Map<string, string>([['pages.md', '# Pages\n\n## Sign-in\n/sign-in\n\n## Dashboard\n/dashboard\n']]);
  const ports: EqualizerPorts = {
    projectRoot: async () => 'C:/project',
    readSpec: async (_root, file) => files.get(file) ?? null,
    writeSpec: async (_root, file, content) => { written.set(file, content); },
    devUrl: async () => 'http://localhost:5173',
    openPage: async (url) => {
      opened.push(url);
      const isDev = url.startsWith('http://localhost');
      return { png: solid(60, 40, isDev ? [200, 0, 0] : [10, 20, 30]), facts: facts([element({ fontSize: isDev ? '18px' : '24px' })]) };
    },
    drawnScreens: async () => ['Sign-in'],
    designConnected: async () => true,
    exportDesignScreen: async () => ({ png: solid(60, 40, [10, 20, 30]), width: 60 }),
    now: () => '2026-10-01T12:00:00.000Z',
    ...over,
  };
  return { ports, written, opened };
}

const BASE = { projectId: 'p1', rounds: 3, round: 0, screens: [{ name: 'Sign-in', route: '/sign-in' }, { name: 'Dashboard', route: '/dashboard' }] };

describe('running the Equalizer', () => {
  it('compares the dev server with a website, screen by screen, and writes the report and pictures', async () => {
    const { ports, written, opened } = fakePorts();
    const report = await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'website', referenceUrl: 'https://example.test' }));
    expect(opened).toEqual(['https://example.test/sign-in', 'http://localhost:5173/sign-in', 'https://example.test/dashboard', 'http://localhost:5173/dashboard']);
    expect(report.screens.map((screen) => screen.status)).toEqual(['differs', 'differs']);
    expect(report.screens[0]?.differences.some((difference) => difference.kind === 'typography')).toBe(true);
    expect(report.screens[0]?.differences.some((difference) => difference.kind === 'pixels')).toBe(true);
    expect(countDifferences(report)).toBeGreaterThan(2);
    expect(report.reportPath).toBe('.kai/spec/equalizer/20261001120000/report.md');
    const files = [...written.keys()];
    expect(files).toContain('equalizer/20261001120000/report.md');
    expect(files).toContain('equalizer/20261001120000/sign-in/difference.png');
    expect(String(written.get('equalizer/20261001120000/report.md'))).toContain('## Sign-in (/sign-in)');
  });

  it('compares with an open-pencil screen picture, and says when a screen is not drawn', async () => {
    const { ports } = fakePorts({ exportDesignScreen: async (name) => (name === 'Sign-in' ? { png: solid(60, 40, [10, 20, 30]), width: 60 } : null) });
    const report = await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'open-pencil' }));
    expect(report.screens.map((screen) => [screen.name, screen.status])).toEqual([['Sign-in', 'differs'], ['Dashboard', 'not-drawn']]);
    expect(report.screens[0]?.pixelDifference).toBeGreaterThan(0.5);
  });

  it('opens the production link when that is the target, and refuses to run without one', async () => {
    const { ports, opened } = fakePorts();
    await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, screens: [BASE.screens[0]], target: 'production', liveUrl: 'https://prod.example.test', reference: 'open-pencil' }));
    expect(opened).toEqual(['https://prod.example.test/sign-in']);
    await expect(new DesktopEqualizer(fakePorts().ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'production', reference: 'open-pencil' }))).rejects.toThrow(/production link/);
  });

  it('needs a website to match when the reference is a website, and open-pencil when it is open-pencil', async () => {
    await expect(new DesktopEqualizer(fakePorts().ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'website' }))).rejects.toThrow(/website to match/);
    await expect(new DesktopEqualizer(fakePorts({ designConnected: async () => false }).ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'open-pencil' }))).rejects.toThrow(/open-pencil is not connected/);
  });

  it('keeps going when one screen cannot be opened', async () => {
    let calls = 0;
    const { ports } = fakePorts({
      openPage: async () => {
        calls += 1;
        if (calls <= 1) throw new Error('The page did not load.');
        return { png: solid(60, 40, [10, 20, 30]), facts: null };
      },
    });
    const report = await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'website', referenceUrl: 'https://example.test' }));
    expect(report.screens[0]).toMatchObject({ status: 'error', error: 'The page did not load.' });
    expect(report.screens[1]?.status).toBe('match');
  });

  it('runs design-only with no browser at all', async () => {
    const { ports, opened } = fakePorts();
    const report = await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'design', reference: 'open-pencil' }));
    expect(opened).toEqual([]);
    expect(report.screens.map((screen) => [screen.name, screen.status])).toEqual([['Sign-in', 'match'], ['Dashboard', 'not-drawn']]);
    expect(reportMarkdown(report)).toContain('design only');
  });

  it('lists the screens a project can be checked on from its pages list, and which are drawn', async () => {
    const listed = await new DesktopEqualizer(fakePorts().ports).screens('p1');
    expect(listed).toEqual({ screens: [{ name: 'Sign-in', route: '/sign-in' }, { name: 'Dashboard', route: '/dashboard' }], drawn: ['Sign-in'], hasPages: true });
  });

  it('reports progress as it goes', async () => {
    const events: Array<{ done: number; total: number; current: string }> = [];
    const { ports } = fakePorts({ progress: (event) => events.push(event) });
    await new DesktopEqualizer(ports).run(equalizerRunInputSchema.parse({ ...BASE, target: 'dev', reference: 'website', referenceUrl: 'https://example.test' }));
    expect(events.map((event) => `${event.done}/${event.total}`)).toEqual(['0/2', '1/2', '2/2']);
  });
});
