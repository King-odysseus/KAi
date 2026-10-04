import { describe, expect, it } from 'vitest';
import { DesktopDevCheck, judgeDevProbe, parseDevProbe, summarizeDevCheck, type DevCheckPorts, type DevProbe } from '../apps/desktop/src/main/dev-check';

/**
 * The dev proof, on its own.
 *
 * The whole value of this check is that it is the only thing in Autopilot that says the project actually runs, so the
 * rules are tested without a browser or a server: what counts as rendered, what a failure reads like, and what the
 * run says when the server never comes up at all.
 */

const rendered: DevProbe = { errorOverlay: '', textLength: 120, appChildren: 4 };

describe('judgeDevProbe', () => {
  it('passes a page that drew something', () => {
    expect(judgeDevProbe(rendered)).toEqual({ ok: true, problem: '' });
  });

  it('fails a page that loaded but drew nothing', () => {
    const judged = judgeDevProbe({ errorOverlay: '', textLength: 0, appChildren: 0 });
    expect(judged.ok).toBe(false);
    expect(judged.problem).toContain('rendered nothing');
  });

  it('fails a dev-server error overlay before it counts words, since an overlay is a wall of text', () => {
    const judged = judgeDevProbe({ errorOverlay: 'Failed to resolve import "./App"', textLength: 4_000, appChildren: 0 });
    expect(judged.ok).toBe(false);
    expect(judged.problem).toContain('Failed to resolve import');
  });

  it('accepts a page that draws without words, as a canvas or an image-led screen does', () => {
    expect(judgeDevProbe({ errorOverlay: '', textLength: 0, appChildren: 2 }).ok).toBe(true);
  });
});

describe('summarizeDevCheck', () => {
  it('names where the app is when everything loaded', () => {
    const said = summarizeDevCheck('http://localhost:5173', [
      { route: '/', ok: true, problem: '' },
      { route: '/pricing', ok: true, problem: '' },
    ]);
    expect(said.passed).toBe(true);
    expect(said.summary).toContain('http://localhost:5173');
    expect(said.summary).toContain('2 pages loaded');
  });

  it('names the failing route and its reason rather than a count', () => {
    const said = summarizeDevCheck('http://localhost:5173', [
      { route: '/', ok: true, problem: '' },
      { route: '/checkout', ok: false, problem: 'The page loaded but rendered nothing.' },
      { route: '/pricing', ok: false, problem: 'Connection refused.' },
    ]);
    expect(said.passed).toBe(false);
    expect(said.summary).toContain('/checkout');
    expect(said.summary).toContain('rendered nothing');
    expect(said.summary).toContain('1 other page failed too');
  });
});

describe('parseDevProbe', () => {
  it('reads the probe back out of the MCP’s text block', () => {
    expect(parseDevProbe('{"errorOverlay":"","textLength":12,"appChildren":3}')).toEqual({ errorOverlay: '', textLength: 12, appChildren: 3 });
  });

  it('answers with a failing shape rather than throwing on a reply it cannot read', () => {
    expect(parseDevProbe('not json at all')).toEqual({ errorOverlay: '', textLength: 0, appChildren: 0 });
  });
});

describe('DesktopDevCheck', () => {
  function ports(overrides: Partial<DevCheckPorts> = {}): DevCheckPorts {
    return {
      previewUrl: async () => 'http://localhost:5173',
      probe: async () => rendered,
      ...overrides,
    };
  }

  it('loads each route and passes when they all render', async () => {
    const loaded: string[] = [];
    const check = new DesktopDevCheck(ports({
      probe: async ({ url }) => { loaded.push(url); return rendered; },
    }));
    const result = await check.run('p1', '/tmp/p', ['/', '/pricing']);
    expect(loaded).toEqual(['http://localhost:5173/', 'http://localhost:5173/pricing']);
    expect(result.passed).toBe(true);
    expect(result.url).toBe('http://localhost:5173');
    expect(result.routes.map((route) => route.route)).toEqual(['/', '/pricing']);
  });

  it('is a failed check with a reason, not an exception, when the server will not start', async () => {
    const check = new DesktopDevCheck(ports({ previewUrl: async () => { throw new Error('No start command was found.'); } }));
    const result = await check.run('p1', '/tmp/p', ['/']);
    expect(result.passed).toBe(false);
    expect(result.url).toBeNull();
    expect(result.summary).toContain('would not start on dev');
    expect(result.summary).toContain('No start command was found.');
  });

  it('keeps one broken page from losing the rest of the run', async () => {
    const check = new DesktopDevCheck(ports({
      probe: async ({ route }) => { if (route === '/checkout') throw new Error('Connection refused.'); return rendered; },
    }));
    const result = await check.run('p1', '/tmp/p', ['/', '/checkout', '/pricing']);
    expect(result.passed).toBe(false);
    expect(result.routes).toEqual([
      { route: '/', ok: true, problem: '' },
      { route: '/checkout', ok: false, problem: 'Connection refused.' },
      { route: '/pricing', ok: true, problem: '' },
    ]);
  });

  it('stops loading routes once the run has been stopped', async () => {
    const controller = new AbortController();
    let calls = 0;
    const check = new DesktopDevCheck(ports({
      probe: async () => { calls += 1; controller.abort(); return rendered; },
    }));
    await check.run('p1', '/tmp/p', ['/', '/pricing', '/checkout'], controller.signal);
    expect(calls).toBe(1);
  });
});
