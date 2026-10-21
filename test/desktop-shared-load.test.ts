import { describe, expect, it } from 'vitest';
import { sharedLoad } from '../apps/desktop/src/main/shared-load';

describe('a load shared by everyone who asks together', () => {
  it('runs one load for eight callers that ask in the same moment', async () => {
    const owner = {};
    let loads = 0;
    const load = async (): Promise<number> => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return 42; };
    const results = await Promise.all(Array.from({ length: 8 }, () => sharedLoad(owner, load, 10_000)));
    expect(results).toEqual([42, 42, 42, 42, 42, 42, 42, 42]);
    expect(loads).toBe(1);
  });

  it('loads again once the window has passed', async () => {
    const owner = {};
    let loads = 0;
    const load = async (): Promise<number> => { loads += 1; return loads; };
    expect(await sharedLoad(owner, load, 1_000, 0)).toBe(1);
    expect(await sharedLoad(owner, load, 1_000, 999)).toBe(1);
    expect(await sharedLoad(owner, load, 1_000, 1_000)).toBe(2);
  });

  it('keeps two different sources apart', async () => {
    const a = {};
    const b = {};
    expect(await sharedLoad(a, async () => 'a', 10_000)).toBe('a');
    expect(await sharedLoad(b, async () => 'b', 10_000)).toBe('b');
  });

  it('does not keep a failure: the next caller tries again', async () => {
    const owner = {};
    let attempt = 0;
    const load = async (): Promise<string> => { attempt += 1; if (attempt === 1) throw new Error('disk busy'); return 'ok'; };
    await expect(sharedLoad(owner, load, 10_000)).rejects.toThrow('disk busy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sharedLoad(owner, load, 10_000)).toBe('ok');
  });
});
