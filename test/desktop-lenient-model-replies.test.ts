import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lenient, lenientIfZod } from '../packages/contracts/src/lenient';
import { interviewTopicsSchema } from '../packages/contracts/src/interview';
import { parseInterviewReply } from '../apps/desktop/src/main/interview';
import { parseGuideNarrative } from '../apps/desktop/src/main/studio-guide-service';

describe('lenient', () => {
  const strict = z.object({
    name: z.string().min(1),
    tags: z.array(z.object({ id: z.number() }).strict()).default([]),
    inner: z.object({ a: z.string() }).strict().optional(),
    mode: z.discriminatedUnion('kind', [z.object({ kind: z.literal('x'), v: z.number() }).strict(), z.object({ kind: z.literal('y') }).strict()]),
  }).strict().refine((value) => value.name !== 'bad', 'name is bad');

  it('refuses extra keys when strict, and ignores them (at every depth) when lenient', () => {
    const input = { name: 'ok', extra: 1, tags: [{ id: 1, junk: true }], inner: { a: 'z', more: 2 }, mode: { kind: 'x', v: 3, noise: 'n' } };
    expect(strict.safeParse(input).success).toBe(false);
    const parsed = lenient(strict).safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ name: 'ok', tags: [{ id: 1 }], inner: { a: 'z' }, mode: { kind: 'x', v: 3 } });
    }
  });

  it('still enforces required fields, types, defaults and refinements', () => {
    const loose = lenient(strict);
    expect(loose.safeParse({ extra: 1, mode: { kind: 'y' } }).success).toBe(false);
    expect(loose.safeParse({ name: 5, mode: { kind: 'y' } }).success).toBe(false);
    expect(loose.safeParse({ name: 'bad', mode: { kind: 'y' } }).success).toBe(false);
    expect(loose.safeParse({ name: 'ok', mode: { kind: 'z' } }).success).toBe(false);
    const withDefault = loose.safeParse({ name: 'ok', mode: { kind: 'y' } });
    expect(withDefault.success && withDefault.data.tags).toEqual([]);
  });

  it('leaves non-schemas alone', () => {
    const stand = { safeParse: () => ({ success: true as const, data: 1 }) };
    expect(lenientIfZod(stand)).toBe(stand);
    expect(lenient(strict)).toBe(lenient(strict));
  });
});

describe('interview replies from a model', () => {
  const reply = (topics: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({
    goal: 'An assistant that files my email attachments to the NAS.',
    assumptions: [],
    topics,
    questions: [{ question: 'Which mail account?', options: ['Zoho', 'Gmail'] }],
    ...extra,
  });

  it('reads the reply from the screenshot: topics the interview never asked for are ignored', () => {
    const parsed = parseInterviewReply(reply({
      users: { status: 'decided', source: 'the idea says "me"' },
      technology: { status: 'assumed', source: 'Composio' },
      accounts: { status: 'open', source: 'not said' },
      permissions: { status: 'open', source: 'not said' },
    }));
    expect(parsed.topics).toEqual({ users: { status: 'decided', source: 'the idea says "me"' } });
    expect(parsed.questions).toEqual([{ question: 'Which mail account?', options: ['Zoho', 'Gmail'] }]);
  });

  it('keeps a topic whose source is missing or long, and drops one whose status is nonsense', () => {
    const parsed = parseInterviewReply(reply({
      data: { status: 'decided' },
      stack: { status: 'assumed', source: 'x'.repeat(400), note: 'extra' },
      hosting: { status: 'maybe', source: 'y' },
      auth: 'yes',
    }));
    expect(parsed.topics.data).toEqual({ status: 'decided', source: 'stated in the idea' });
    expect(parsed.topics.stack?.source).toHaveLength(120);
    expect(parsed.topics.hosting).toBeUndefined();
    expect(parsed.topics.auth).toBeUndefined();
  });

  it('accepts missing, null or oddly shaped topics, and extra top-level keys', () => {
    expect(parseInterviewReply(reply(undefined, { notes: 'extra', confidence: 0.4 })).topics).toEqual({});
    expect(parseInterviewReply(reply(null)).topics).toEqual({});
    expect(parseInterviewReply(reply(['users', 'data'])).topics).toEqual({});
  });

  it('still refuses a reply that has no goal', () => {
    expect(() => parseInterviewReply(JSON.stringify({ topics: {}, questions: [] }))).toThrow(/expected shape/);
  });

  it('schema-level: saved state also tolerates an unknown topic key', () => {
    expect(interviewTopicsSchema.parse({ users: { status: 'open', source: 's' }, technology: { status: 'open', source: 's' } })).toEqual({ users: { status: 'open', source: 's' } });
    expect(interviewTopicsSchema.parse(undefined)).toEqual({});
  });
});

describe('other model-reply parsers', () => {
  it('reads a guide reply that carries an extra key', () => {
    const base = JSON.parse(JSON.stringify({ steps: [] })) as Record<string, unknown>;
    // The shape check itself is the guide's own; an unknown top-level key must not be what fails it.
    let message = '';
    try { parseGuideNarrative(JSON.stringify({ ...base, brandNewKey: 'x' })); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).not.toMatch(/Unrecognized key/);
  });
});
