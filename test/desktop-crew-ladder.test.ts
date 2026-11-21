import { describe, expect, it } from 'vitest';
import { createDefaultCrewConfig, crewConfigSchema, crewRunSchema, crewSavings } from '@kai/contracts';
import type { CrewRun } from '@kai/contracts';
import { addTasks, clearSettledAsk, escalatedRole, isLocalRole, noteBuild, shouldEscalate } from '../apps/desktop/src/main/crew-engine';

const T0 = '2026-11-21T10:00:00.000Z';

function localBuilderConfig(patch: Record<string, unknown> = {}) {
  const base = createDefaultCrewConfig('claude', 'codex');
  return crewConfigSchema.parse({
    ...base,
    ...patch,
    roles: base.roles.map((role) => (role.id === 'builder' ? { ...role, execution: 'api', api: { provider: 'ollama', model: 'qwen3-coder' } } : role)),
  });
}

function runWith(config = localBuilderConfig()): CrewRun {
  const run = crewRunSchema.parse({ schemaVersion: 1, id: 'run_1', projectId: 'p1', goal: 'Build it', status: 'running', config, tasks: [], feed: [], startedAt: T0, updatedAt: T0 });
  return addTasks(run, [{ id: 'a', title: 'First card', role: 'builder', acceptance: ['It works'] }], T0).run;
}

describe('the model ladder rules', () => {
  const config = localBuilderConfig();
  const builder = config.roles.find((role) => role.id === 'builder')!;

  it('knows a local role from a paid one', () => {
    expect(isLocalRole(builder)).toBe(true);
    expect(isLocalRole(config.roles.find((role) => role.id === 'lead')!)).toBe(false);
  });

  it('gives a local builder its attempts, then escalates', () => {
    expect(shouldEscalate(config, builder, 1)).toBe(false);
    expect(shouldEscalate(config, builder, 2)).toBe(false);
    expect(shouldEscalate(config, builder, 3)).toBe(true);
  });

  it('honours how many attempts the local model gets', () => {
    const patient = localBuilderConfig({ savings: { escalateAfter: 4 } });
    expect(shouldEscalate(patient, builder, 4)).toBe(false);
    expect(shouldEscalate(patient, builder, 5)).toBe(true);
  });

  it('never escalates when local first is off, or for a builder that is not local', () => {
    expect(shouldEscalate(localBuilderConfig({ savings: { localFirst: false } }), builder, 9)).toBe(false);
    expect(shouldEscalate(config, config.roles.find((role) => role.id === 'lead')!, 9)).toBe(false);
  });

  it('builds an escalated attempt as the Lead\'s model while the card keeps its owner', () => {
    const stronger = escalatedRole(config, builder)!;
    expect(stronger.id).toBe('builder');
    expect(stronger.label).toBe(builder.label);
    expect(stronger.access).toBe('edit');
    expect(stronger.execution).toBe('cli');
    expect(stronger.agent).toBe('claude');
    expect(stronger.api).toBeUndefined();
  });

  it('uses the crew\'s chosen stronger target when there is one', () => {
    const chosen = localBuilderConfig({ escalation: { execution: 'api', api: { provider: 'anthropic', model: 'claude-opus-5-5' } } });
    const stronger = escalatedRole(chosen, chosen.roles.find((role) => role.id === 'builder')!)!;
    expect(stronger.execution).toBe('api');
    expect(stronger.api?.provider).toBe('anthropic');
    expect(stronger.model).toBe('claude-opus-5-5');
  });

  it('refuses to "escalate" to another local model', () => {
    const sideways = localBuilderConfig({ escalation: { execution: 'api', api: { provider: 'lmstudio', model: 'bigger-local' } } });
    expect(escalatedRole(sideways, sideways.roles.find((role) => role.id === 'builder')!)).toBeNull();
  });
});

describe('counting builds and savings', () => {
  it('records who built a card and counts it by tier', () => {
    let run = runWith();
    run = noteBuild(run, 'a', 'local', false, T0);
    run = noteBuild(run, 'a', 'local', false, T0);
    run = noteBuild(run, 'a', 'cloud', true, T0);
    const task = run.tasks[0]!;
    expect(task.tier).toBe('cloud');
    expect(task.escalated).toBe(true);
    expect(run.tiers).toEqual({ localBuilds: 2, cloudBuilds: 1, escalations: 1 });
  });

  it('keeps a card marked escalated after a later local build', () => {
    let run = runWith();
    run = noteBuild(run, 'a', 'cloud', true, T0);
    run = noteBuild(run, 'a', 'local', false, T0);
    expect(run.tasks[0]!.escalated).toBe(true);
  });

  it('says nothing about savings until a paid build gives it something to compare with', () => {
    let run = runWith();
    run = noteBuild(run, 'a', 'local', false, T0);
    expect(crewSavings(run).estimatedSavedUsd).toBeNull();
  });

  it('estimates savings from this run\'s own paid builds, never a price list', () => {
    let run = runWith();
    run = addTasks(run, [{ id: 'b', title: 'Second card', role: 'builder', acceptance: ['It works'] }], T0).run;
    run = noteBuild(run, 'a', 'cloud', true, T0);
    run = { ...run, tasks: run.tasks.map((task) => (task.id === 'a' ? { ...task, costUsd: 0.5 } : task)), spentUsd: 0.5 };
    run = noteBuild(run, 'b', 'local', false, T0);
    run = noteBuild(run, 'b', 'local', false, T0);
    const saved = crewSavings(run);
    expect(saved.localBuilds).toBe(2);
    expect(saved.cloudBuilds).toBe(1);
    expect(saved.estimatedSavedUsd).toBe(1);
    expect(saved.spentUsd).toBe(0.5);
  });
});

describe('saved runs from before the ladder', () => {
  it('open with the ladder on and zeroed counts', () => {
    const base = createDefaultCrewConfig('claude', 'codex');
    const { savings: _savings, ...withoutSavings } = base as unknown as Record<string, unknown>;
    const config = crewConfigSchema.parse(withoutSavings);
    expect(config.savings.localFirst).toBe(true);
    expect(config.savings.escalateAfter).toBe(2);
    expect(config.escalation).toBeNull();
    const run = crewRunSchema.parse({ schemaVersion: 1, id: 'old', projectId: 'p1', goal: 'Old run', status: 'completed', config, tasks: [], feed: [], startedAt: T0, updatedAt: T0 });
    expect(run.tiers).toEqual({ localBuilds: 0, cloudBuilds: 0, escalations: 0 });
  });
});

describe('a question about a task that is already done', () => {
  const ask = { reason: 'noProgress' as const, message: 'The local builder could not finish it.', taskId: 'a' };

  it('is dropped, and a run that was waiting on it carries on', () => {
    let run = runWith();
    run = { ...run, status: 'needsYou', ask, tasks: run.tasks.map((task) => ({ ...task, status: 'accepted' as const })) };
    const cleared = clearSettledAsk(run, T0);
    expect(cleared.ask).toBeNull();
    expect(cleared.status).toBe('running');
  });

  it('is kept while its task is still waiting on the person', () => {
    let run = runWith();
    run = { ...run, status: 'needsYou', ask, tasks: run.tasks.map((task) => ({ ...task, status: 'needsYou' as const })) };
    expect(clearSettledAsk(run, T0)).toBe(run);
  });

  it('never drops a limit or an approval, which belong to the whole run', () => {
    let run = runWith();
    const limit = { reason: 'spend' as const, message: 'The spend limit was reached.', taskId: 'a' };
    run = { ...run, status: 'needsYou', ask: limit, tasks: run.tasks.map((task) => ({ ...task, status: 'accepted' as const })) };
    expect(clearSettledAsk(run, T0).ask).toEqual(limit);
  });

  it('brings up the next open question once the settled one is gone', () => {
    let run = runWith();
    run = addTasks(run, [{ id: 'b', title: 'Second card', role: 'builder', acceptance: ['It works'] }], T0).run;
    const second = { reason: 'noProgress' as const, message: 'Second card is stuck.', taskId: 'b' };
    run = { ...run, status: 'needsYou', ask, queuedAsks: [second], tasks: run.tasks.map((task) => ({ ...task, status: task.id === 'a' ? ('accepted' as const) : ('needsYou' as const) })) };
    const cleared = clearSettledAsk(run, T0);
    expect(cleared.ask).toEqual(second);
    expect(cleared.queuedAsks).toEqual([]);
  });
});

describe('a gateway on the home network is a local builder', () => {
  const withGateway = (baseUrl: string) => {
    const base = createDefaultCrewConfig('claude', 'codex');
    return crewConfigSchema.parse({
      ...base,
      roles: base.roles.map((role) => (role.id === 'builder' ? { ...role, execution: 'api', api: { provider: 'openai-compatible', baseUrl, model: 'gateway/coding' } } : role)),
    });
  };

  it('counts a gateway at a private address as local, so it gets small cards and the ladder', () => {
    const config = withGateway('http://192.168.68.70:8000/v1');
    const builder = config.roles.find((role) => role.id === 'builder')!;
    expect(isLocalRole(builder)).toBe(true);
    expect(shouldEscalate(config, builder, 3)).toBe(true);
    expect(escalatedRole(config, builder)?.execution).toBe('cli');
  });

  it('does not count a gateway on the public internet as local', () => {
    const config = withGateway('https://gateway.example.com/v1');
    const builder = config.roles.find((role) => role.id === 'builder')!;
    expect(isLocalRole(builder)).toBe(false);
    expect(shouldEscalate(config, builder, 9)).toBe(false);
  });
});
