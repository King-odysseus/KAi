import { describe, expect, it } from 'vitest';
import { Cognitive1HttpClient } from '../src/cognitive1/cognitive1-client';

describe('Cognitive1HttpClient', () => {
  it('summarizes health responses', async () => {
    const client = new Cognitive1HttpClient('http://c1.test', async () =>
      new Response(JSON.stringify({ status: 'ok', uptime: 12 }), { status: 200 })
    );

    await expect(client.health()).resolves.toEqual({
      available: true,
      detail: 'Cognitive1 ready (12s uptime).'
    });
  });

  it('summarizes recall results', async () => {
    const client = new Cognitive1HttpClient('http://c1.test', async () =>
      new Response(JSON.stringify({
        results: [
          { type: 'patterns', title: 'Use adapter contracts', date: '2026-07-03', agent: 'test', fields: {} }
        ]
      }), { status: 200 })
    );

    await expect(client.recall({ query: 'adapter' })).resolves.toBe('Recall found 1 result(s): [patterns] Use adapter contracts');
  });

  it('returns an unavailable summary instead of throwing', async () => {
    const client = new Cognitive1HttpClient('http://c1.test', async () => {
      throw new Error('connection refused');
    });

    await expect(client.sessionStart({ agent: 'kai', task: 'test' })).resolves.toBe(
      'Cognitive1 session_start unavailable: connection refused'
    );
  });
});

