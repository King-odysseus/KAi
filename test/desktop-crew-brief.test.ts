import { describe, expect, it } from 'vitest';
import { compileBrief, keepGoingFrom } from '../apps/desktop/src/renderer/src/crew-brief';
import { createDefaultSettings } from '@kai/contracts';
import { DesktopCrewInterview, digestPlanText, goalFilePaths, parseCrewInterview, withAutonomyQuestion } from '../apps/desktop/src/main/crew-interview';

describe('writing the interview answers under the goal', () => {
  it('lists what was answered and says what was left to the crew', () => {
    const brief = compileBrief('Build Zuri', [
      { topic: 'scope', question: 'How much to do now?', answer: 'Just Phase 1' },
      { topic: 'done', question: 'What counts as finished?', answer: '' },
    ]);
    expect(brief.startsWith('Build Zuri')).toBe(true);
    expect(brief).toContain('- How much to do now? Just Phase 1');
    expect(brief).toContain('- What counts as finished? Left to the crew to decide.');
  });

  it('leaves the goal alone with no answers, and never cuts the goal to fit them', () => {
    expect(compileBrief('Build Zuri', [])).toBe('Build Zuri');
    const long = 'x'.repeat(3_990);
    expect(compileBrief(long, [{ topic: 'scope', question: 'Q?', answer: 'A' }])).toBe(long);
  });

  it('drops the last answers, not the first, when they do not all fit', () => {
    const goal = 'g'.repeat(3_700);
    const answers = Array.from({ length: 6 }, (_, index) => ({ topic: 'scope', question: `Question ${index}?`, answer: 'a'.repeat(100) }));
    const brief = compileBrief(goal, answers);
    expect(brief.length).toBeLessThanOrEqual(4_000);
    expect(brief).toContain('Question 0?');
    expect(brief).not.toContain('Question 5?');
  });

  it('reads the keep-going choice from the autonomy answer', () => {
    expect(keepGoingFrom([{ topic: 'autonomy', question: 'q', answer: 'Keep going through every phase' }])).toBe(true);
    expect(keepGoingFrom([{ topic: 'autonomy', question: 'q', answer: 'Stop after each phase and ask me' }])).toBe(false);
    expect(keepGoingFrom([{ topic: 'autonomy', question: 'q', answer: '' }])).toBeUndefined();
    expect(keepGoingFrom([])).toBeUndefined();
  });
});

describe('finding and digesting the plan a goal names', () => {
  it('finds quoted and bare document paths', () => {
    expect(goalFilePaths('"C:\\Users\\Me\\WorkSpace\\docs\\zuricopilot-plan.md"  implement this plan')).toEqual(['C:\\Users\\Me\\WorkSpace\\docs\\zuricopilot-plan.md']);
    expect(goalFilePaths('follow docs/plan.md please')).toEqual(['docs/plan.md']);
    expect(goalFilePaths('build a login screen')).toEqual([]);
  });

  it('keeps a short plan whole, and a long one\'s outline and its phase section', () => {
    expect(digestPlanText('# Plan\nDo it.')).toBe('# Plan\nDo it.');
    const filler = Array.from({ length: 900 }, (_, index) => `Filler line ${index} about nothing in particular.`).join('\n');
    const plan = `# Plan\nOpening words.\n\n## 3. Background\n${filler}\n\n## 19. Phases\n### Phase 0 - Spike\nProve the sidecar design.\n### Phase 1 - Shell\nThe window model.\n`;
    const digest = digestPlanText(plan, 6_000);
    expect(digest.length).toBeLessThanOrEqual(6_000);
    expect(digest).toContain('## 19. Phases');
    expect(digest).toContain('Prove the sidecar design.');
    expect(digest).toContain('### Phase 1 - Shell');
  });
});

describe('the start interview service', () => {
  const settings = (enabled: boolean) => ({ ...createDefaultSettings(), promptGuide: { ...createDefaultSettings().promptGuide, enabled } });
  const reply = JSON.stringify({
    summary: 'Build from the plan.', phases: ['Phase 0', 'Phase 1'],
    topics: [{ key: 'scope', importance: 'must', reason: 'Two phases.' }],
    questions: [{ topic: 'scope', question: 'Which phases?', why: 'Two phases.', options: ['Phase 0 only', 'Both'] }],
  });

  function service(options: { enabled?: boolean; fail?: boolean; files?: Record<string, string> } = {}) {
    const prompts: string[] = [];
    const interview = new DesktopCrewInterview({
      settings: async () => settings(options.enabled ?? true),
      requester: {
        structuredRequest: async (_connection, _names, prompt, _schemaName, _schema, parse) => {
          prompts.push(prompt.user);
          if (options.fail) throw new Error('timed out');
          return parse(reply) as never;
        },
      },
      projectRoot: async () => 'C:/proj',
      readText: async (file) => options.files?.[file.replace(/\\/g, '/')] ?? null,
      readBrief: async () => null,
    });
    return { interview, prompts };
  }

  it('reads the plan file the goal names, asks the questions, and adds the how-far question for several phases', async () => {
    const { interview, prompts } = service({ files: { 'C:/plans/zuri-plan.md': '# Plan\n## Phases\n### Phase 0\nSpike.' } });
    const result = await interview.run({ projectId: 'p1', goal: '"C:/plans/zuri-plan.md" implement this plan' });
    expect(prompts[0]).toContain('### Phase 0');
    expect(result.usedFiles).toEqual(['zuri-plan.md']);
    expect(result.items.map((item) => item.topic)).toEqual(['scope', 'autonomy']);
  });

  it('gives no questions, and says why, when the model is off or does not answer', async () => {
    const off = await service({ enabled: false }).interview.run({ projectId: 'p1', goal: 'Build it' });
    expect(off.items).toEqual([]);
    expect(off.note).toContain('Prompt Guide model is off');
    const failed = await service({ fail: true }).interview.run({ projectId: 'p1', goal: 'Build it' });
    expect(failed.items).toEqual([]);
    expect(failed.note).toContain('timed out');
  });
});

describe('reading the Lead\'s interview reply', () => {
  const reply = JSON.stringify({
    summary: 'Build the Zuri desktop copilot from its plan.',
    phases: ['Phase 0: Spike', 'Phase 1: Shell', ' '],
    topics: [
      { key: 'scope', importance: 'must', reason: 'The plan has ten phases.' },
      { key: 'done', importance: 'skip', reason: 'The plan states acceptance for every phase.' },
      { key: 'run', importance: 'worth', reason: 'It is a desktop app.' },
    ],
    questions: [
      { topic: 'scope', question: 'Which phases should it do now?', why: 'Ten phases is a lot to check at once.', options: ['Phase 0 only', 'Phases 0 to 2', 'All of them'] },
      { topic: 'done', question: 'What counts as finished?', why: '', options: ['Tests pass'] },
      { topic: 'run', question: 'How is it run?', why: 'So it can be tried.', options: [] },
    ],
  });

  it('asks about topics that matter, lists the rest as left out with the reason, and drops empty phases', () => {
    const read = parseCrewInterview(reply)!;
    expect(read.items.map((item) => item.topic)).toEqual(['scope', 'run']);
    expect(read.left).toEqual([{ topic: 'done', reason: 'The plan states acceptance for every phase.' }]);
    expect(read.phases).toEqual(['Phase 0: Spike', 'Phase 1: Shell']);
  });

  it('adds the how-far-to-go question only when there is more than one phase', () => {
    const read = parseCrewInterview(reply)!;
    expect(withAutonomyQuestion(read).items.at(-1)).toMatchObject({ topic: 'autonomy', options: ['Stop after each phase and ask me', 'Keep going through every phase'] });
    const single = { ...read, phases: ['Only one'] };
    expect(withAutonomyQuestion(single).items.some((item) => item.topic === 'autonomy')).toBe(false);
  });

  it('reads nothing from prose', () => {
    expect(parseCrewInterview('No questions needed.')).toBeNull();
  });
});
