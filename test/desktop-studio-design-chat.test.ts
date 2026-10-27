import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardCardSchema, createDefaultSettings, type StudioReadiness } from '../packages/contracts/src';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { SpecStore } from '../apps/desktop/src/main/spec-store';
import { DesktopStudio, type StudioPorts } from '../apps/desktop/src/main/studio';
import { hashFile } from '../apps/desktop/src/main/verification';

/**
 * Before this, every design-chat turn carried the whole project: every page's board card and every screen pulled
 * from open-pencil, even to ask about one of them. A `pageName` scopes the turn to just that page, so a correction
 * to Checkout cannot see, and cannot be tempted to "fix", Home or Account.
 */

const NOW = '2026-10-27T12:00:00.000Z';
const READY: StudioReadiness = { ready: true, displayName: 'OpenAI', model: 'gpt-6-luna', reason: null };
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-studio-design-chat-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeStudio(over: Partial<StudioPorts> = {}) {
  const settings = createDefaultSettings();
  const artifacts = new StudioArtifacts({ spec: new SpecStore(), projectRoot: async () => root, now: () => NOW });
  const board = new StudioBoardStore({
    spec: new SpecStore(),
    projectRoot: async () => root,
    dirtyFiles: async () => [],
    hashFile: (projectRoot, relative) => hashFile(projectRoot, relative),
    run: async () => null,
    now: () => NOW,
  });
  const prompts: string[] = [];
  const ports: StudioPorts = {
    settings: async () => settings,
    projectRoot: async () => root,
    requester: { structuredRequest: () => Promise.reject(new Error('not used')) },
    interview: { readiness: async () => READY },
    artifacts,
    board,
    uiCheck: { check: async () => { throw new Error('not used'); } } as unknown as StudioPorts['uiCheck'],
    now: () => NOW,
    ensureOpenPencilRunning: async () => {},
    runDesignAgent: async (prompt) => {
      prompts.push(prompt);
      return { status: 'completed', output: 'done' };
    },
    ...over,
  };
  return { studio: new DesktopStudio(ports), prompts, board };
}

describe('design chat scoped to one page', () => {
  it('carries only the named page, not the rest of the project', async () => {
    const { studio, prompts, board } = makeStudio();
    await board.replace('p1', [
      boardCardSchema.parse({ id: 'c-home', title: 'Home', kind: 'page', route: '/', designRef: 'node-home', createdAt: NOW, updatedAt: NOW }),
      boardCardSchema.parse({ id: 'c-checkout', title: 'Checkout', kind: 'page', route: '/checkout', designRef: 'node-checkout', createdAt: NOW, updatedAt: NOW }),
    ], []);
    await board.saveDesign('p1', {
      schemaVersion: 1,
      endpoint: 'http://127.0.0.1:7600',
      pulledAt: NOW,
      treeHash: 'th1',
      hashes: {},
      components: [
        { id: 'node-home', name: 'Home', page: 'Home', screen: true },
        { id: 'node-checkout', name: 'Checkout', page: 'Checkout', screen: true },
      ],
    });

    await studio.chatDesign('p1', 'Move the price under the title', undefined, 'step-1', undefined, 'Checkout');

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain('scoped to ONE page: "Checkout"');
    expect(prompt).toContain('c-checkout: Checkout');
    expect(prompt).toContain('node-checkout');
    // The whole-project sections are gone outright, replaced by the single-page ones.
    expect(prompt).not.toContain('BOARD SCREENS');
    expect(prompt).not.toContain('PROJECT PAGE INVENTORY');
    expect(prompt).toContain('THE PAGE IN SCOPE');
    expect(prompt).toContain('THIS PAGE AS LAST PULLED FROM OPEN PENCIL');
    // Within those scoped sections specifically, only Checkout is named — Home's own card/node never is.
    const scopedSection = prompt.slice(prompt.indexOf('THE PAGE IN SCOPE'), prompt.indexOf('PROJECT SOURCE CONTEXT'));
    expect(scopedSection).not.toContain('c-home');
    expect(scopedSection).not.toContain('node-home');
  });

  it('still says what changed when the named page is not on the board yet', async () => {
    const { studio, prompts } = makeStudio();

    await studio.chatDesign('p1', 'Add a page for order history', undefined, 'step-1', undefined, 'Order history');

    expect(prompts[0]).toContain('"Order history" is not on the board yet.');
  });

  it('carries the whole project when no page is named, exactly as before', async () => {
    const { studio, prompts, board } = makeStudio();
    await board.replace('p1', [
      boardCardSchema.parse({ id: 'c-home', title: 'Home', kind: 'page', createdAt: NOW, updatedAt: NOW }),
    ], []);

    await studio.chatDesign('p1', 'What pages exist?', undefined, 'step-1');

    expect(prompts[0]).toContain('BOARD SCREENS');
    expect(prompts[0]).toContain('PROJECT PAGE INVENTORY');
    expect(prompts[0]).not.toContain('scoped to ONE page');
  });
});

describe('capturing a page screenshot for the Design tab preview', () => {
  it('switches the editor to the page, then screenshots whatever it shows', async () => {
    const switched: string[] = [];
    const endpoints: string[] = [];
    const { studio } = makeStudio({
      openPencil: async () => ({
        endpoint: () => 'http://127.0.0.1:7600',
        async call(tool, input) {
          switched.push(`${tool}:${JSON.stringify(input)}`);
          return [{ type: 'text', text: JSON.stringify({ ok: true }) }];
        },
      }),
      screenshotDesignPage: async (endpoint) => {
        endpoints.push(endpoint);
        return 'ZmFrZQ==';
      },
    });

    const result = await studio.capturePageScreenshot('p1', 'node-checkout');

    expect(switched).toEqual(['switch_page:{"page":"node-checkout"}']);
    expect(endpoints).toEqual(['http://127.0.0.1:7600']);
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,ZmFrZQ==' });
  });

  it('fails with open-pencil\'s own reason when the page cannot be switched to', async () => {
    const { studio } = makeStudio({
      openPencil: async () => ({
        endpoint: () => 'http://127.0.0.1:7600',
        async call() {
          return [{ type: 'text', text: JSON.stringify({ error: 'no such page' }) }];
        },
      }),
      screenshotDesignPage: async () => { throw new Error('must not be called'); },
    });

    await expect(studio.capturePageScreenshot('p1', 'missing')).rejects.toThrow(/no such page/);
  });

  it('fails plainly when open-pencil is not connected', async () => {
    const { studio } = makeStudio({ openPencil: async () => null });
    await expect(studio.capturePageScreenshot('p1', 'node-checkout')).rejects.toThrow(/open-pencil is not connected/);
  });
});
