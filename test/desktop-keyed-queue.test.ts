import { describe, expect, it } from 'vitest';
import { KeyedQueue } from '../apps/desktop/src/main/keyed-queue';

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('keyed queue: taking turns', () => {
  it('runs work for one key strictly one at a time, in the order it was asked for', async () => {
    const queue = new KeyedQueue<string>();
    const log: string[] = [];
    const job = (name: string, ms: number) => async (): Promise<string> => { log.push(`start ${name}`); await tick(ms); log.push(`end ${name}`); return name; };
    const results = await Promise.all([queue.run('c1', job('a', 20)), queue.run('c1', job('b', 1)), queue.run('c1', job('c', 5))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('does not let one failure block the work behind it', async () => {
    const queue = new KeyedQueue<string>();
    const failing = queue.run('c1', async () => { throw new Error('boom'); });
    const after = queue.run('c1', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });

  it('lets different keys work at the same time', async () => {
    const queue = new KeyedQueue<string>();
    const log: string[] = [];
    const slow = queue.run('c1', async () => { log.push('c1 start'); await tick(30); log.push('c1 end'); });
    const quick = queue.run('proxy', async () => { log.push('proxy start'); log.push('proxy end'); });
    await Promise.all([slow, quick]);
    expect(log.indexOf('proxy end')).toBeLessThan(log.indexOf('c1 end'));
  });
});

describe('keyed queue: sharing one piece of work', () => {
  it('gives everyone who asks while it runs the same result, and runs it once', async () => {
    const queue = new KeyedQueue<string>();
    let runs = 0;
    const work = async (): Promise<number> => { runs += 1; await tick(15); return runs; };
    const results = await Promise.all([queue.share('c1', work), queue.share('c1', work), queue.share('c1', work)]);
    expect(results).toEqual([1, 1, 1]);
    expect(runs).toBe(1);
    // Once it has finished, the next caller starts a fresh one.
    expect(await queue.share('c1', work)).toBe(2);
  });

  it('shares a failure with everyone waiting, and starts fresh afterwards', async () => {
    const queue = new KeyedQueue<string>();
    let runs = 0;
    const work = async (): Promise<void> => { runs += 1; await tick(5); throw new Error(`failed ${runs}`); };
    const settled = await Promise.allSettled([queue.share('c1', work), queue.share('c1', work)]);
    expect(settled.map((item) => item.status)).toEqual(['rejected', 'rejected']);
    expect(runs).toBe(1);
    await expect(queue.share('c1', work)).rejects.toThrow('failed 2');
  });
});

describe('the restart race this fixes', () => {
  /** A stand-in for the service: one port that only one gateway can hold, as on the real machine. */
  function fakeService(queue: KeyedQueue<string>, mode: 'queued' | 'unqueued') {
    const state = { holder: null as number | null, starts: 0, failures: [] as string[], orphaned: 0 };
    const known = { gateway: null as number | null };
    let next = 0;
    async function restartWork(): Promise<void> {
      // Close what we know about, then take the port: the shape of restart() before and after the fix.
      if (known.gateway !== null && state.holder === known.gateway) state.holder = null;
      known.gateway = null;
      await tick(3);
      const mine = (next += 1);
      if (state.holder !== null) {
        state.failures.push('port already in use');
        // The old cleanup forgot whatever gateway was recorded, even one this call never made.
        if (mode === 'unqueued') { if (known.gateway !== null) state.orphaned += 1; known.gateway = null; }
        return;
      }
      state.holder = mine;
      known.gateway = mine;
      state.starts += 1;
      await tick(3);
    }
    const restart = (): Promise<void> => (mode === 'queued' ? queue.share('c1', restartWork) : restartWork());
    return { state, restart };
  }

  it('without taking turns, overlapping restarts collide on the port', async () => {
    const service = fakeService(new KeyedQueue<string>(), 'unqueued');
    await Promise.all([service.restart(), service.restart(), service.restart()]);
    expect(service.state.failures.length).toBeGreaterThan(0);
  });

  it('with taking turns, five restarts asked at once make one restart and no failure', async () => {
    const service = fakeService(new KeyedQueue<string>(), 'queued');
    await Promise.all(Array.from({ length: 5 }, () => service.restart()));
    expect(service.state.failures).toEqual([]);
    expect(service.state.starts).toBe(1);
    // A later restart still works: the port was released properly, not left held.
    await service.restart();
    expect(service.state.failures).toEqual([]);
    expect(service.state.starts).toBe(2);
  });
});
