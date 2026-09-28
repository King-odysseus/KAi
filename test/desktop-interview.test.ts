import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, interviewOpenQuestions, interviewStateSchema, STUDIO_MAX_ROUNDS, type InterviewState } from '../packages/contracts/src';
import { briefMarkdown, buildInterviewPrompt, DesktopInterview, parseInterviewReply, type InterviewPorts } from '../apps/desktop/src/main/interview';
import { SpecStore, specHistoryPath } from '../apps/desktop/src/main/spec-store';

const NOW = '2026-09-28T12:00:00.000Z';
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-interview-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function state(overrides: Partial<InterviewState> = {}): InterviewState {
  return interviewStateSchema.parse({
    projectId: 'p1',
    idea: 'A booking site for a barber shop.',
    goal: '',
    assumptions: [],
    rounds: [],
    status: 'asking',
    briefPath: null,
    updatedAt: NOW,
    ...overrides,
  });
}

/** A requester that replays canned replies in order; the last one repeats if the interview asks again. */
function requesterOf(replies: string[]): InterviewPorts['requester'] {
  let call = 0;
  return {
    structuredRequest: <T,>() => {
      const reply = replies[call] ?? replies[replies.length - 1] ?? '{}';
      call += 1;
      return Promise.resolve(parseInterviewReply(reply) as unknown as T);
    },
  };
}

function ports(overrides: Partial<InterviewPorts> = {}, replies: string[] = []): InterviewPorts {
  const settings = createDefaultSettings();
  return {
    settings: () => Promise.resolve({ ...settings, promptGuide: { ...settings.promptGuide, enabled: true } }),
    projectRoot: () => Promise.resolve(root),
    credentialStored: () => Promise.resolve(true),
    vaultAvailable: () => true,
    requester: requesterOf(replies),
    store: memoryStore(),
    spec: { write: (projectRoot, relativePath, content) => new SpecStore().write(projectRoot, relativePath, content) },
    now: () => NOW,
    ...overrides,
  };
}

function memoryStore(seed: InterviewState | null = null): InterviewPorts['store'] & { current: InterviewState | null } {
  const holder = {
    current: seed,
    read: () => Promise.resolve(holder.current),
    write: (next: InterviewState) => { holder.current = next; return Promise.resolve(); },
    clear: () => { holder.current = null; return Promise.resolve(); },
  };
  return holder;
}

describe('Project Studio interview', () => {
  it('is off unless the Prompt Guide connection is set up, and says which key to fix', async () => {
    const off = new DesktopInterview(ports({ settings: async () => { const settings = createDefaultSettings(); return { ...settings, promptGuide: { ...settings.promptGuide, enabled: false } }; } }));
    expect((await off.readiness()).reason).toMatch(/Turn it on/);
    const noKey = new DesktopInterview(ports({ credentialStored: () => Promise.resolve(false) }));
    expect((await noKey.readiness()).reason).toMatch(/Save the provider.openai key/);
    expect((await new DesktopInterview(ports()).readiness()).ready).toBe(true);
  });

  it('asks a first round, keeping the reply on the model side of the contract', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({
      goal: 'Let a barber shop take deposits online.',
      assumptions: ['Card payments only'],
      questions: ['How many chairs?', 'Who cancels a booking?', 'How many chairs?'],
    })]));
    const started = await interview.start({ projectId: 'p1', idea: 'A booking site for a barber shop.' });
    expect(started.status).toBe('asking');
    expect(started.goal).toMatch(/deposits/);
    expect(started.assumptions).toEqual(['Card payments only']);
    // The repeated question is dropped, so the user is never asked the same thing twice in one round.
    expect(started.rounds[0]?.questions).toEqual(['How many chairs?', 'Who cancels a booking?']);
    expect(interviewOpenQuestions(started)).toHaveLength(2);
  });

  it('shows the model what was answered, and marks what was skipped', () => {
    const prompt = buildInterviewPrompt(state({
      goal: 'Take deposits online.',
      rounds: [{ questions: ['How many chairs?', 'Which card provider?'], answers: [{ question: 'How many chairs?', answer: 'Two' }, { question: 'Which card provider?', answer: '' }] }],
    }), null);
    expect(prompt.user).toContain('Q: How many chairs?\nA: Two');
    expect(prompt.user).toContain('Skipped (decide these yourself):\n- Which card provider?');
    expect(prompt.system).toContain('Never repeat a question the user has already answered');
    expect(prompt.system).toContain('Do not ask for secrets');
  });

  it('keeps an already-answered question out of the next round', async () => {
    const interview = new DesktopInterview(ports({}, [
      JSON.stringify({ goal: 'Take deposits.', assumptions: [], questions: ['How many chairs?'] }),
      JSON.stringify({ goal: 'Take deposits.', assumptions: [], questions: ['How many chairs?', 'Who cancels?'] }),
    ]));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    const answered = await interview.answer({ projectId: 'p1', answers: [{ question: 'How many chairs?', answer: 'Two' }] });
    expect(answered.rounds[1]?.questions).toEqual(['Who cancels?']);
  });

  it('finishes and writes the brief when the model has nothing left to ask', async () => {
    const memory = memoryStore();
    const interview = new DesktopInterview(ports({ store: memory }, [
      JSON.stringify({ goal: 'Take deposits.', assumptions: ['Two chairs'], questions: ['How many chairs?'] }),
      JSON.stringify({ goal: 'Take deposits.', assumptions: ['Two chairs'], questions: [] }),
    ]));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    const done = await interview.answer({ projectId: 'p1', answers: [{ question: 'How many chairs?', answer: 'Two' }] });
    expect(done.status).toBe('done');
    expect(done.briefPath).toBe('.kai/spec/brief.md');
    // The brief is read back off disk, which is exactly what the board and the agents will do.
    const written = await new SpecStore().read(root, 'brief.md');
    expect(written).toContain('# Take deposits.');
    expect(written).toContain('**How many chairs?**');
    expect(written).toContain('Two');
    expect(memory.current?.status).toBe('done');
  });

  it('stops after the round budget instead of paying for another round', async () => {
    const replies = Array.from({ length: STUDIO_MAX_ROUNDS }, (_value, index) => JSON.stringify({
      goal: `Goal ${index + 1}`,
      assumptions: [],
      questions: [`Question ${index + 1}`],
    }));
    const interview = new DesktopInterview(ports({}, replies));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    let current = await interview.answer({ projectId: 'p1', answers: [] });
    current = await interview.answer({ projectId: 'p1', answers: [] });
    expect(current.status).toBe('asking');
    current = await interview.answer({ projectId: 'p1', answers: [] });
    expect(current.status).toBe('done');
    expect(current.rounds).toHaveLength(STUDIO_MAX_ROUNDS);
  });

  it('refuses a second interview while one is in progress, and a reset clears it', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({ goal: 'Take deposits.', assumptions: [], questions: ['How many chairs?'] })]));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    await expect(interview.start({ projectId: 'p1', idea: 'Something else.' })).rejects.toThrow(/already in progress/);
    expect(await interview.reset({ projectId: 'p1' })).toBeNull();
    expect(await interview.read({ projectId: 'p1' })).toBeNull();
  });

  it('lists what was skipped in the brief rather than pretending it was decided', () => {
    const brief = briefMarkdown(state({
      goal: 'Take deposits online.',
      assumptions: ['Card payments only'],
      status: 'done',
      rounds: [{ questions: ['How many chairs?', 'Refunds?'], answers: [{ question: 'How many chairs?', answer: 'Two' }, { question: 'Refunds?', answer: '' }] }],
    }), NOW);
    expect(brief).toContain('# Take deposits online.');
    expect(brief).toContain('## Left to the agents');
    expect(brief).toContain('- Refunds?');
    expect(brief).toContain('_Written by the KAI Project Studio on 2026-09-28T12:00:00.000Z._');
  });

  it('fails clearly when the reply is missing the goal', () => {
    // Assumptions and questions default when absent, so the goal is the one field a reply cannot omit.
    expect(() => parseInterviewReply('{"assumptions":[],"questions":[]}')).toThrow(/did not match the expected shape/);
  });

  it('keeps the copy it replaced, so a regenerate never loses the last good brief', async () => {
    const store = new SpecStore();
    expect(await store.write(root, 'brief.md', 'first')).toEqual({ path: '.kai/spec/brief.md', version: 0 });
    expect(await store.write(root, 'brief.md', 'second')).toEqual({ path: '.kai/spec/brief.md', version: 1 });
    expect(await store.read(root, 'brief.md')).toBe('second');
    // The replaced copy sits beside the artifact, named by the version the write reported.
    expect(specHistoryPath('brief.md', 1)).toBe('.kai/spec/.history/brief/v1/brief.md');
    expect(fs.readFileSync(path.join(root, '.kai', 'spec', '.history', 'brief', 'v1', 'brief.md'), 'utf8')).toBe('first');
    // History is bookkeeping, not an artifact: the studio must not list it as something to build.
    expect(await store.list(root)).toEqual(['brief.md']);
  });
});
