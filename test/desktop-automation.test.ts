import { describe, expect, it } from 'vitest';
import type { AgentRunRequest, AgentRunResult, ConversationRecord, ProjectAutomation } from '../packages/contracts/src';
import { buildFixPrompt, runWithAutomation, type AutomationPorts, type ShellResult } from '../apps/desktop/src/main/automation';

const request: AgentRunRequest = { conversationId: 'c1', prompt: 'add a feature', agent: 'claude', route: 'direct', autonomy: 'autoEdit' };

interface Harness {
  ports: AutomationPorts;
  prompts: string[];
  notes: string[];
  shell: string[];
  checks: string[];
}

/** A conversation whose last user turn reports the files the most recent run changed. */
function harness(options: {
  automation?: ProjectAutomation;
  changed?: string[];
  statuses?: Array<'completed' | 'failed'>;
  shellExit?: (command: string, call: number) => number | null;
  shellOutput?: string;
  suggested?: string | null;
}): Harness {
  const prompts: string[] = [];
  const notes: string[] = [];
  const shell: string[] = [];
  const checks: string[] = [];
  let runs = 0;
  let shellCalls = 0;
  const conversation = (): ConversationRecord => ({
    schemaVersion: 1,
    id: 'c1',
    projectId: 'p1',
    title: 't',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false,
    unread: false,
    activeAgent: null,
    route: null,
    autonomy: null,
    turns: [{ id: 'u', role: 'user', text: 'x', createdAt: '2026-01-01T00:00:00.000Z', fileChanges: (options.changed ?? []).map((path) => ({ path, added: 1, removed: 0 })) }],
    events: [],
  });
  const ports: AutomationPorts = {
    runOnce: async (turn) => {
      prompts.push(turn.prompt);
      const status = options.statuses?.[runs] ?? 'completed';
      runs += 1;
      return { conversation: conversation(), status, output: 'done' } as AgentRunResult;
    },
    automation: async () => options.automation,
    conversation: async () => conversation(),
    suggestCheck: async () => options.suggested ?? null,
    runShell: async (command): Promise<ShellResult> => {
      shell.push(command);
      shellCalls += 1;
      return { exitCode: options.shellExit ? options.shellExit(command, shellCalls) : 0, output: options.shellOutput ?? 'output' };
    },
    recordCheck: async (command) => { checks.push(command); },
    note: async (text) => { notes.push(text); },
    review: async () => 'Review: no problems found.',
  };
  return { ports, prompts, notes, shell, checks };
}

describe('runWithAutomation', () => {
  it('is exactly one agent turn when no automation is set up', async () => {
    const h = harness({ automation: undefined, changed: ['a.ts'] });
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.prompts).toEqual(['add a feature']);
    expect(h.shell).toEqual([]);
    expect(outcome.fixRounds).toBe(0);
    expect(outcome.checkPassed).toBeNull();
  });

  it('runs the check once and stops when it passes', async () => {
    const h = harness({ automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 2 } }, changed: ['a.ts'] });
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.shell).toEqual(['npm test']);
    expect(h.checks).toEqual(['npm test']);
    expect(outcome.checkPassed).toBe(true);
    expect(outcome.fixRounds).toBe(0);
    expect(h.notes).toEqual(['Check passed: npm test']);
  });

  it('sends failures back to the agent and stops once the check passes', async () => {
    const h = harness({
      automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 3 } },
      changed: ['a.ts'],
      shellExit: (_command, call) => (call < 3 ? 1 : 0),
      shellOutput: 'FAIL src/a.test.ts',
    });
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts[1]).toContain('`npm test`');
    expect(h.prompts[1]).toContain('FAIL src/a.test.ts');
    expect(outcome.fixRounds).toBe(2);
    expect(outcome.checkPassed).toBe(true);
    expect(h.notes.at(-1)).toContain('Check passed after 2 automatic fixes');
  });

  it('gives up after the round limit and says so', async () => {
    const h = harness({ automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 2 } }, changed: ['a.ts'], shellExit: () => 1 });
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.prompts).toHaveLength(3);
    expect(h.shell).toHaveLength(3);
    expect(outcome.checkPassed).toBe(false);
    expect(h.notes.at(-1)).toContain('still failing after 2 automatic fixes');
  });

  it('does nothing extra when the agent changed no files', async () => {
    const h = harness({ automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 2 }, review: { enabled: true } }, changed: [] });
    await runWithAutomation(h.ports, request);
    expect(h.shell).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('does not check or fix a run that failed', async () => {
    const h = harness({ automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 2 } }, changed: ['a.ts'], statuses: ['failed'] });
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.shell).toEqual([]);
    expect(outcome.result.status).toBe('failed');
  });

  it('falls back to the detected command, and explains when there is none', async () => {
    const detected = harness({ automation: { autoCheck: { enabled: true, maxRounds: 1 } }, changed: ['a.ts'], suggested: 'cargo test' });
    await runWithAutomation(detected.ports, request);
    expect(detected.shell).toEqual(['cargo test']);

    const none = harness({ automation: { autoCheck: { enabled: true, maxRounds: 1 } }, changed: ['a.ts'], suggested: null });
    await runWithAutomation(none.ports, request);
    expect(none.shell).toEqual([]);
    expect(none.notes[0]).toContain('no check command');
  });

  it('stops before the agent when a beforeRun hook fails, and feeds a passing hook to the agent', async () => {
    const blocked = harness({ automation: { hooks: { beforeRun: [{ command: 'lint-staged' }] } }, shellExit: () => 2, shellOutput: 'dirty tree' });
    const stopped = await runWithAutomation(blocked.ports, request);
    expect(blocked.prompts).toEqual([]);
    expect(stopped.result.status).toBe('failed');
    expect(stopped.result.error).toContain('beforeRun hook failed');
    expect(stopped.result.error).toContain('dirty tree');

    const context = harness({ automation: { hooks: { beforeRun: [{ command: 'git status --short' }] } }, shellOutput: 'M a.ts' });
    await runWithAutomation(context.ports, request);
    expect(context.prompts[0]).toContain('M a.ts');
    expect(context.prompts[0]).toContain('add a feature');
  });

  it('runs afterEdit hooks only after edits, reports their failures, and adds the review', async () => {
    const h = harness({
      automation: { hooks: { afterEdit: [{ command: 'prettier --write .' }], afterRun: [{ command: 'notify' }] }, review: { enabled: true } },
      changed: ['a.ts'],
      shellExit: (command) => (command === 'prettier --write .' ? 1 : 0),
    });
    await runWithAutomation(h.ports, request);
    expect(h.shell).toEqual(['prettier --write .', 'notify']);
    expect(h.notes[0]).toContain('afterEdit hook failed');
    expect(h.notes).toContain('Review: no problems found.');
  });

  it('stops without asking the agent to fix anything when the user presses Stop during a check', async () => {
    let stopped = false;
    const h = harness({ automation: { autoCheck: { enabled: true, command: 'npm test', maxRounds: 3 } }, changed: ['a.ts'], shellExit: () => { stopped = true; return null; } });
    h.ports.cancelled = () => stopped;
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.prompts).toHaveLength(1);
    expect(h.shell).toEqual(['npm test']);
    expect(h.checks).toEqual([]);
    expect(h.notes).toEqual(['Stopped while checking your changes.']);
    expect(outcome.fixRounds).toBe(0);
  });

  it('does not start the agent when Stop was pressed before it began', async () => {
    const h = harness({ automation: { hooks: { beforeRun: [{ command: 'echo hi' }] } } });
    h.ports.cancelled = () => true;
    const outcome = await runWithAutomation(h.ports, request);
    expect(h.prompts).toEqual([]);
    expect(outcome.result.status).toBe('failed');
  });

  it('builds a fix prompt that names the command and keeps the output tail', () => {
    const prompt = buildFixPrompt('npm test', { exitCode: 1, output: `${'x'.repeat(10_000)}TAIL` }, 1, 2);
    expect(prompt).toContain('check 1 of 2');
    expect(prompt).toContain('TAIL');
    expect(prompt.length).toBeLessThan(7_000);
    expect(prompt).toContain('do not weaken or delete tests');
  });
});
