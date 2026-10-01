import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, interviewAnswerInputSchema, interviewOpenQuestions, interviewStateSchema, STUDIO_MAX_QUESTIONS, STUDIO_MAX_ROUNDS, type InterviewState } from '../packages/contracts/src';
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
    linkedProjectId: null,
    idea: 'A booking site for a barber shop.',
    goal: '',
    assumptions: [],
    rounds: [],
    status: 'asking',
    briefPath: null,
    archivedAt: null,
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
    list: () => Promise.resolve(holder.current ? [holder.current] : []),
    read: () => Promise.resolve(holder.current),
    write: (next: InterviewState) => { holder.current = next; return Promise.resolve(); },
    clear: () => { holder.current = null; return Promise.resolve(); },
  };
  return holder;
}

describe('Project Studio interview', () => {
  it('accepts a detailed requirements answer of up to 4,000 characters', () => {
    const answer = 'a'.repeat(4_000);
    expect(interviewAnswerInputSchema.parse({ projectId: 'p1', answers: [{ question: 'What is in scope?', answer }] }).answers[0]?.answer).toBe(answer);
    expect(() => interviewAnswerInputSchema.parse({ projectId: 'p1', answers: [{ question: 'What is in scope?', answer: `${answer}a` }] })).toThrow();
  });

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
    // Each model call asks one question, so the next one can react to the answer before it.
    expect(started.rounds[0]?.questions).toEqual(['How many chairs?']);
    expect(interviewOpenQuestions(started)).toHaveLength(1);
  });

  it('keeps a new plan independent unless a folder is explicitly linked', async () => {
    const roots: Array<string | null | undefined> = [];
    const interview = new DesktopInterview(ports({
      projectRoot: (_projectId, linkedProjectId) => {
        roots.push(linkedProjectId);
        return Promise.resolve(root);
      },
    }, [JSON.stringify({ goal: 'Build a booking site.', assumptions: [], questions: ['Who signs in?'] })]));

    const standalone = await interview.start({ projectId: 'studio_11111111-1111-4111-8111-111111111111', idea: 'Booking site.' });
    expect(standalone.linkedProjectId).toBeNull();
    expect(roots[0]).toBeNull();

    roots.length = 0;
    const linkedInterview = new DesktopInterview(ports({
      projectRoot: (_projectId, linkedProjectId) => {
        roots.push(linkedProjectId);
        return Promise.resolve(root);
      },
    }, [JSON.stringify({ goal: 'Build a booking site.', assumptions: [], questions: ['Who signs in?'] })]));
    const linked = await linkedInterview.start({
      projectId: 'studio_22222222-2222-4222-8222-222222222222',
      idea: 'Booking site for the open folder.',
      linkedProjectId: 'project_open_folder',
    });
    expect(linked.linkedProjectId).toBe('project_open_folder');
    expect(roots[0]).toBe('project_open_folder');
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

  it('stops after the question budget instead of paying for another call', async () => {
    const replies = Array.from({ length: STUDIO_MAX_ROUNDS }, (_value, index) => JSON.stringify({
      goal: `Goal ${index + 1}`,
      assumptions: [],
      questions: [`Question ${index + 1}`],
    }));
    const interview = new DesktopInterview(ports({}, replies));
    let current = await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    for (let answered = 1; answered < STUDIO_MAX_ROUNDS; answered += 1) {
      current = await interview.answer({ projectId: 'p1', answers: [] });
      expect(current.status).toBe('asking');
    }
    current = await interview.answer({ projectId: 'p1', answers: [] });
    expect(current.status).toBe('done');
    expect(current.rounds).toHaveLength(STUDIO_MAX_ROUNDS);
  });

  it('never asks more than ten questions, one per call, even when the model offers more', async () => {
    const replies = Array.from({ length: 12 }, (_value, index) => JSON.stringify({
      goal: `Goal ${index + 1}`,
      assumptions: [],
      questions: [`Question ${index + 1} a`, `Question ${index + 1} b`, `Question ${index + 1} c`, `Question ${index + 1} d`],
    }));
    const interview = new DesktopInterview(ports({}, replies));
    let current = await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    expect(current.rounds[0]?.questions).toEqual(['Question 1 a']);
    while (current.status === 'asking') current = await interview.answer({ projectId: 'p1', answers: [] });
    expect(current.rounds.flatMap((round) => round.questions)).toHaveLength(STUDIO_MAX_QUESTIONS);
  });

  it('keeps the suggested answers the model gives for each question', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({
      goal: 'Booking site.',
      assumptions: [],
      questions: [
        { question: 'Which platform?', options: ['React PWA', 'Web app', 'react pwa', 'Desktop app'] },
        'Who pays the deposit?',
      ],
    })]));
    const state = await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    expect(state.rounds[0]?.questions).toEqual(['Which platform?']);
    expect(state.rounds[0]?.options).toEqual([['React PWA', 'Web app', 'Desktop app']]);
  });

  it('lets a newcomer ask for five more questions at a time, up to twenty, and no further', async () => {
    const replies = Array.from({ length: 25 }, (_value, index) => JSON.stringify({ goal: `Goal ${index + 1}`, assumptions: [], questions: [`Question ${index + 1}`] }));
    const interview = new DesktopInterview(ports({}, replies));
    let current = await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    expect(current.extraQuestions).toBe(0);
    current = await interview.extend({ projectId: 'p1' });
    expect(current.extraQuestions).toBe(5);
    current = await interview.extend({ projectId: 'p1' });
    expect(current.extraQuestions).toBe(10);
    await expect(interview.extend({ projectId: 'p1' })).rejects.toThrow(/20 questions/);
    while (current.status === 'asking') current = await interview.answer({ projectId: 'p1', answers: [] });
    expect(current.rounds.flatMap((round) => round.questions)).toHaveLength(20);
  });

  it('tells the model to cover technology and design, recommend an option, and look after a newcomer', () => {
    const { system } = buildInterviewPrompt({ idea: 'A booking site.', goal: '', assumptions: [], rounds: [], extraQuestions: 5 }, null);
    expect(system).toMatch(/the technology to build it with/);
    expect(system).toMatch(/visual design/);
    expect(system).toMatch(/Not sure, you decide/);
    expect(system).toMatch(/\(recommended\)/);
    expect(system).toMatch(/no more than 15 questions/);
  });

  it('refuses a second interview while one is in progress, and a reset clears it', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({ goal: 'Take deposits.', assumptions: [], questions: ['How many chairs?'] })]));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    await expect(interview.start({ projectId: 'p1', idea: 'Something else.' })).rejects.toThrow(/already in progress/);
    expect(await interview.reset({ projectId: 'p1' })).toBeNull();
    expect(await interview.read({ projectId: 'p1' })).toBeNull();
  });

  it('lists Studio projects by the discussion title rather than a filesystem name', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({ goal: 'Build a tutor portal.', assumptions: [], questions: ['Who signs in?'] })]));
    await interview.start({ projectId: 'studio_11111111-1111-4111-8111-111111111111', idea: 'A portal for tutors.' });
    expect(await interview.list()).toEqual([
      expect.objectContaining({
        id: 'studio_11111111-1111-4111-8111-111111111111',
        title: 'Build a tutor portal.',
        idea: 'A portal for tutors.',
        status: 'asking',
      }),
    ]);
  });

  it('archives, restores, and deletes a Studio project', async () => {
    const memory = memoryStore();
    const interview = new DesktopInterview(ports({ store: memory }, [JSON.stringify({ goal: 'Build a tutor portal.', assumptions: [], questions: [] })]));
    const id = 'studio_11111111-1111-4111-8111-111111111111';
    await interview.start({ projectId: id, idea: 'A portal for tutors.' });

    const archived = await interview.setArchived({ projectId: id, archived: true });
    expect(archived.archivedAt).toBe(NOW);
    expect((await interview.list())[0]?.archivedAt).toBe(NOW);

    const restored = await interview.setArchived({ projectId: id, archived: false });
    expect(restored.archivedAt).toBeNull();

    expect(await interview.remove({ projectId: id })).toBeNull();
    expect(await interview.read({ projectId: id })).toBeNull();
    expect(await interview.list()).toEqual([]);
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
