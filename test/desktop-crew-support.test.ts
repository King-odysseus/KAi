import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig } from '@kai/contracts';
import { NodeFileSystem } from '../packages/runtime/src';
import { CrewSupport } from '../apps/desktop/src/main/crew-support';

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-crew-support-'));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe('crew support', () => {
  it('saves crew defaults per project and for everyone, and a project\'s own wins', async () => {
    await withDir(async (dir) => {
      const support = new CrewSupport(path.join(dir, 'defaults.json'), new NodeFileSystem());
      expect(await support.defaults('p1')).toBeNull();
      const shared = createDefaultCrewConfig('claude', 'codex');
      const own = createDefaultCrewConfig('codex', 'codex');
      await support.saveDefaults(undefined, shared);
      expect((await support.defaults('p1'))?.roles[0]?.agent).toBe('claude');
      await support.saveDefaults('p1', own);
      expect((await support.defaults('p1'))?.roles[0]?.agent).toBe('codex');
      expect((await support.defaults('p2'))?.roles[0]?.agent).toBe('claude');
      await support.saveDefaults('p1', null);
      expect((await support.defaults('p1'))?.roles[0]?.agent).toBe('claude');
    });
  });

  it('looks at Open Pencil without launching it, opens it only when asked, and says so when it is not set up', async () => {
    await withDir(async (dir) => {
      let opened = 0;
      const wired = new CrewSupport(path.join(dir, 'a.json'), new NodeFileSystem(), {
        designStatus: async () => ({ state: 'running', pages: [{ id: 'p1', name: 'Home' }] }),
        designEnsure: async () => { opened += 1; },
      });
      expect((await wired.design(false)).pages).toEqual([{ id: 'p1', name: 'Home' }]);
      expect(opened).toBe(0);
      await wired.design(true);
      expect(opened).toBe(1);
      const bare = new CrewSupport(path.join(dir, 'b.json'), new NodeFileSystem());
      expect(await bare.design(false)).toEqual({ state: 'not-configured', pages: [] });
    });
  });
});
