import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, clipOption, clipToLength, interviewAnswerInputSchema, interviewOpenQuestions, interviewStateSchema, projectTitleFrom, STUDIO_MAX_ASSUMPTION_CHARS, STUDIO_MAX_OPTIONS, STUDIO_MAX_OPTION_CHARS, STUDIO_MAX_QUESTION_CHARS, STUDIO_MAX_QUESTIONS, STUDIO_MAX_ROUNDS, type InterviewState } from '../packages/contracts/src';
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

/**
 * A project's name, out of its goal.
 *
 * The goal is a full statement of what "done" looks like and can run to 4,000 characters. Using it whole made a
 * project's name its entire brief: it filled the project list and the Studio header, became the brief's own `#`
 * heading, and was repeated into every design prompt under the heading it had already been given.
 */
describe('naming a project', () => {
  it('takes the first sentence, when the goal has one', () => {
    expect(projectTitleFrom('SharpSite, a locked-template website builder for Nigerian small businesses. Starting with ten fashion designers.'))
      .toBe('SharpSite, a locked-template website builder for Nigerian small businesses.');
  });

  it('cuts a long first sentence at a word boundary rather than mid-word', () => {
    const sentence = 'A very long single sentence with no full stop anywhere in it at all, running on and on well past any sensible length for a name';
    const title = projectTitleFrom(sentence);

    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
    // The kept text is a prefix of the sentence and the cut falls on a space, so no word is cut through.
    const kept = title.slice(0, -1);
    expect(kept).toBe(kept.trimEnd());
    expect(sentence.startsWith(kept)).toBe(true);
    expect(sentence[kept.length]).toBe(' ');
    expect(kept).toContain('A very long single sentence');
  });

  it('falls back through the sources it is given, and returns nothing when none has text', () => {
    expect(projectTitleFrom('', '   ', 'The idea.')).toBe('The idea.');
    expect(projectTitleFrom(undefined, null)).toBe('');
    expect(projectTitleFrom('', '')).toBe('');
  });

  it('leaves an ordinary short name exactly as it was', () => {
    expect(projectTitleFrom('SharpSite')).toBe('SharpSite');
  });
});

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
    await interview.start({ projectId: 'p1', idea: 'Booking site in Next.js with a light colour palette.' });
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

  it('rewrites an answer and asks again from there, dropping the rounds that followed it', async () => {
    const replies = [
      JSON.stringify({ goal: 'Goal one', assumptions: [], questions: ['Which platform?'] }),
      JSON.stringify({ goal: 'Goal two', assumptions: [], questions: ['Who pays?'] }),
      JSON.stringify({ goal: 'Goal three', assumptions: [], questions: ['Which currency?'] }),
      JSON.stringify({ goal: 'Goal four', assumptions: [], questions: ['How do you take payment?'] }),
    ];
    const interview = new DesktopInterview(ports({}, replies));
    let current = await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    current = await interview.answer({ projectId: 'p1', answers: [{ question: 'Which platform?', answer: 'A web app' }] });
    current = await interview.answer({ projectId: 'p1', answers: [{ question: 'Who pays?', answer: 'The salon' }] });
    expect(current.rounds.flatMap((round) => round.questions)).toEqual(['Which platform?', 'Who pays?', 'Which currency?']);

    current = await interview.correct({ projectId: 'p1', question: 'Which platform?', answer: 'A native phone app' });

    // The corrected answer stands, and the questions chosen from the old one are gone rather than left arguing
    // with it. The model asks again from the corrected point.
    expect(current.rounds[0]?.answers).toEqual([{ question: 'Which platform?', answer: 'A native phone app' }]);
    expect(current.rounds.flatMap((round) => round.questions)).toEqual(['Which platform?', 'How do you take payment?']);
    expect(current.goal).toBe('Goal four');
  });

  it('discards no answered question when the most recent answer is the one corrected', async () => {
    const replies = [
      JSON.stringify({ goal: 'Goal one', assumptions: [], questions: ['Which platform?'] }),
      JSON.stringify({ goal: 'Goal two', assumptions: [], questions: ['Who pays?'] }),
      JSON.stringify({ goal: 'Goal three', assumptions: [], questions: ['Who pays, then?'] }),
    ];
    const interview = new DesktopInterview(ports({}, replies));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });
    await interview.answer({ projectId: 'p1', answers: [{ question: 'Which platform?', answer: 'A web app' }] });

    const current = await interview.correct({ projectId: 'p1', question: 'Which platform?', answer: 'A native app' });

    // Only the question nobody had answered yet is asked again.
    expect(current.rounds.flatMap((round) => round.answers).filter((answer) => answer.answer)).toEqual([
      { question: 'Which platform?', answer: 'A native app' },
    ]);
  });

  it('keeps the answers beside the corrected one when a round holds more than one', async () => {
    // Rounds normally ask one question, but the shape allows four; correcting one must not blank the others.
    const seeded = state({
      rounds: [{
        questions: ['Which platform?', 'Who pays?'],
        options: [['Web app'], ['The salon']],
        answers: [{ question: 'Which platform?', answer: 'A web app' }, { question: 'Who pays?', answer: 'The salon' }],
      }],
    });
    const interview = new DesktopInterview(ports({ store: memoryStore(seeded) }, [
      JSON.stringify({ goal: 'Goal', assumptions: [], questions: ['Which currency?'] }),
    ]));

    const current = await interview.correct({ projectId: 'p1', question: 'Who pays?', answer: 'The client' });

    expect(current.rounds[0]?.answers).toEqual([
      { question: 'Which platform?', answer: 'A web app' },
      { question: 'Who pays?', answer: 'The client' },
    ]);
  });

  it('refuses to correct a question the interview never asked', async () => {
    const interview = new DesktopInterview(ports({}, [JSON.stringify({ goal: 'Goal', assumptions: [], questions: ['Which platform?'] })]));
    await interview.start({ projectId: 'p1', idea: 'Booking site.' });

    await expect(interview.correct({ projectId: 'p1', question: 'Who pays?', answer: 'The salon' })).rejects.toThrow(/not part of this interview/);
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

  it('feeds the described style images into the next question, and points the model at the image button', () => {
    const withImages = buildInterviewPrompt({ idea: 'A booking site.', goal: '', assumptions: [], rounds: [] }, null, '- Palette: deep navy, mint accent');
    expect(withImages.user).toContain('The user attached reference images');
    expect(withImages.user).toContain('deep navy, mint accent');
    expect(withImages.system).toMatch(/image button next to the answer box/);
    const without = buildInterviewPrompt({ idea: 'A booking site.', goal: '', assumptions: [], rounds: [] }, null);
    expect(without.user).not.toContain('reference images');
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

  it('shortens an over-long suggested answer instead of failing the round', () => {
    // The reported failure: one option past the limit rejected the whole reply, and the question went with it.
    const long = 'Use a curated prompt template plus fixed settings for each mode, so staff pick a mode and the app fills in the provider, model, temperature, output format and the required inputs for it';
    expect(long.length).toBeGreaterThan(STUDIO_MAX_OPTION_CHARS);
    const reply = JSON.stringify({
      goal: 'Build ZuriAi.',
      assumptions: ['Naira pricing.'],
      questions: [{ question: 'How should a mode work?', options: [long, 'Not sure, you decide'] }],
    });

    const parsed = parseInterviewReply(reply);

    expect(parsed.goal).toBe('Build ZuriAi.');
    expect(parsed.assumptions).toEqual(['Naira pricing.']);
    expect(parsed.questions[0].question).toBe('How should a mode work?');
    const [first] = parsed.questions[0].options;
    expect(first.length).toBeLessThanOrEqual(STUDIO_MAX_OPTION_CHARS);
    // Cut at a word boundary, so the chip reads as a shortened answer rather than one that stops mid-word.
    expect(first.endsWith('…')).toBe(true);
    expect(first).not.toMatch(/\s…$/);
    // The recommended answer is offered first, so it is shortened rather than dropped.
    expect(parsed.questions[0].options).toHaveLength(2);
  });

  it('keeps the question when the model offers more answers than there are chips', () => {
    const reply = JSON.stringify({
      goal: 'Build ZuriAi.',
      questions: [{ question: 'How should a mode work?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }],
    });

    expect(parseInterviewReply(reply).questions[0].options).toHaveLength(STUDIO_MAX_OPTIONS);
  });

  it('cuts a suggested answer at a word boundary, and to the limit when there is no space to cut at', () => {
    expect(clipOption('  a   b  ')).toBe('a b');
    expect(clipOption('short enough')).toBe('short enough');

    const words = clipOption('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega and more words to push it well past the limit');
    expect(words.length).toBeLessThanOrEqual(STUDIO_MAX_OPTION_CHARS);
    expect(words.endsWith('…')).toBe(true);
    expect(words).not.toMatch(/\s…$/);

    // One enormous word has nowhere to break, so it is cut where it falls rather than returned over-length.
    expect(clipOption('x'.repeat(300)).length).toBe(STUDIO_MAX_OPTION_CHARS);
  });

  it('shortens an over-long assumption instead of failing the round', () => {
    // The reported failure, after the one about a long suggested answer. A reply is a single object, so a field
    // over its limit took the goal, the question and the other assumptions down with it.
    const long = 'The brief has to explain how spend is recorded in Naira at the current rate, and why provider fees are paid with a USD virtual card from a Nigerian fintech, because Naira debit cards often fail on foreign API charges. '.repeat(3).trim();
    expect(long.length).toBeGreaterThan(STUDIO_MAX_ASSUMPTION_CHARS);
    const reply = JSON.stringify({
      goal: 'Build ZuriAi.',
      assumptions: [long, 'Naira pricing.'],
      questions: ['How should a mode work?'],
    });

    const parsed = parseInterviewReply(reply);

    expect(parsed.goal).toBe('Build ZuriAi.');
    expect(parsed.questions[0].question).toBe('How should a mode work?');
    expect(parsed.assumptions).toHaveLength(2);
    for (const assumption of parsed.assumptions) expect(assumption.length).toBeLessThanOrEqual(STUDIO_MAX_ASSUMPTION_CHARS);
    expect(parsed.assumptions[0]?.endsWith('…')).toBe(true);
  });

  it('shortens an over-long question, and drops blank assumptions and blank answers', () => {
    const longQuestion = `Which of these best describes how a member of staff picks a mode and then a provider for it, given the choice changes the price and the speed ${'and then some more'.repeat(20)}`;
    const reply = JSON.stringify({
      goal: 'Build ZuriAi.',
      assumptions: ['   ', 'Naira pricing.'],
      questions: [{ question: longQuestion, options: ['', 'Web app', '  ', 'Desktop app'] }],
    });

    const parsed = parseInterviewReply(reply);

    expect(parsed.assumptions).toEqual(['Naira pricing.']);
    expect(parsed.questions[0].question.length).toBeLessThanOrEqual(STUDIO_MAX_QUESTION_CHARS);
    expect(parsed.questions[0].options).toEqual(['Web app', 'Desktop app']);
  });

  it('cuts text at a word boundary, and to the limit when there is no space to cut at', () => {
    expect(clipToLength('a b', 400)).toBe('a b');
    const words = clipToLength('alpha beta gamma delta epsilon zeta eta theta iota kappa', 20);
    expect(words.length).toBeLessThanOrEqual(20);
    expect(words).not.toMatch(/\s…$/);
    // Nothing to break at, so it is cut where it falls rather than returned over-length.
    expect(clipToLength('y'.repeat(500), 20).length).toBe(20);
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
  it('asks for the stack instead of finishing when the model assumed it', async () => {
    const interview = new DesktopInterview(ports({ store: memoryStore() }, [
      JSON.stringify({ goal: 'A booking site.', assumptions: ['Web app'], questions: [] }),
    ]));
    const state = await interview.start({ projectId: 'p2', idea: 'Booking site for a salon.' });
    expect(state.status).toBe('asking');
    expect(state.rounds[0].questions[0]).toMatch(/built with/i);
  });
});

