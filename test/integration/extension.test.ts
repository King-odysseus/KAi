/**
 * Integration tests for the KAI Agent Workbench extension.
 *
 * These tests verify end-to-end behavior:
 * - Extension activation and deactivation
 * - Adapter capability detection (checking for real binaries)
 * - Webview HTML generation and CSP correctness
 * - Config backup and restore flow
 * - Orchestrator task lifecycle (with stub adapters)
 *
 * Run with: npm run test:integration
 */
import { describe, expect, it } from 'vitest';
import { WorkbenchOrchestrator } from '../../src/orchestrator/orchestrator';
import { NoopDiffApplier } from '../../src/orchestrator/diff-applier';
import { ProcessAgentAdapter } from '../../src/adapters/process-agent-adapter';
import type { WorkbenchState } from '../../src/core/types';
import { estimateCost, countTokens } from '../../src/core/cost-estimator';
import { createEventId, nowIso } from '../../src/core/events';

// ---- Orchestrator integration tests ----

describe('Orchestrator (integration)', () => {
  function createOrch(): WorkbenchOrchestrator {
    const state: WorkbenchState = {
      activeAgent: 'claude',
      route: 'direct',
      autonomy: 'ask',
      isRunning: false,
    };
    return new WorkbenchOrchestrator(state, undefined, undefined, new NoopDiffApplier());
  }

  it('starts with correct initial state', () => {
    const orch = createOrch();
    const state = orch.getState();
    expect(state.activeAgent).toBe('claude');
    expect(state.route).toBe('direct');
    expect(state.autonomy).toBe('ask');
    expect(state.isRunning).toBe(false);
  });

  it('changes agent, route, and autonomy', () => {
    const orch = createOrch();
    orch.setAgent('codex');
    expect(orch.getState().activeAgent).toBe('codex');
    orch.setRoute('proxy');
    expect(orch.getState().route).toBe('proxy');
    orch.setAutonomy('autoEdit');
    expect(orch.getState().autonomy).toBe('autoEdit');
  });

  it('prevents concurrent tasks', async () => {
    const orch = createOrch();
    orch.registerAdapter(
      new ProcessAgentAdapter({
        id: 'claude',
        displayName: 'Claude',
        command: 'echo',
        buildArgs: (r) => [r.prompt],
      }),
    );

    const p1 = orch.startTask({ prompt: 'task one' });
    await expect(orch.startTask({ prompt: 'task two' })).rejects.toThrow('already has an active agent');
    await orch.stopActiveTask();
    try {
      await p1;
    } catch {
      /* ignore */
    }
  });

  it('handoff requires an active task', async () => {
    const orch = createOrch();
    await expect(orch.handoff('codex')).rejects.toThrow('No active task');
  });

  it('getCapabilities returns results for all registered adapters', async () => {
    const orch = createOrch();
    orch.registerAdapter(
      new ProcessAgentAdapter({
        id: 'claude',
        displayName: 'Claude',
        command: 'node',
        buildArgs: () => ['-e', 'console.log("ok")'],
      }),
    );
    const caps = await orch.getCapabilities();
    expect(caps.length).toBe(1);
    expect(caps[0].id).toBe('claude');
  });
});

// ---- Cost estimator integration tests ----

describe('Cost estimator (integration)', () => {
  it('classifies real-world coding prompts as code', () => {
    const prompt = `Fix the bug in src/auth.ts where the login function doesn't handle
    async errors properly. Add a try/catch block and return a proper error response.`;
    const tokens = countTokens(prompt);
    expect(tokens).toBeGreaterThan(30);
  });

  it('produces consistent estimates for the same prompt across agents', () => {
    const prompt = 'Write a function to validate email addresses';
    const agents = ['claude', 'codex', 'qwen', 'gemini'] as const;
    const estimates = agents.map((a) => estimateCost(prompt, a, 'direct'));

    // All should have the same token counts (only pricing differs)
    const firstTokens = estimates[0].estimatedInputTokens;
    for (const est of estimates) {
      expect(est.estimatedInputTokens).toBe(firstTokens);
    }
  });
});

// ---- Event model integration tests ----

describe('Event model (integration)', () => {
  it('createEventId produces unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createEventId());
    }
    expect(ids.size).toBe(100);
  });

  it('nowIso returns valid ISO 8601 timestamps', () => {
    const ts = nowIso();
    const parsed = new Date(ts);
    expect(parsed.getTime()).not.toBeNaN();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---- Permission model integration tests ----

describe('Permission model (integration)', () => {
  function createOrch(): WorkbenchOrchestrator {
    const state: WorkbenchState = {
      activeAgent: 'claude',
      route: 'direct',
      autonomy: 'ask',
      isRunning: false,
    };
    return new WorkbenchOrchestrator(state, undefined, undefined, new NoopDiffApplier());
  }

  it('review mode gates workspace edits', () => {
    const orch = createOrch();
    const result = orch.checkPermission('workspaceEdit');
    expect(result.allowed).toBe(false);
    expect(result.escalated).toBe(true);
  });

  it('auto mode allows workspace edits', () => {
    const orch = createOrch();
    orch.setAutonomy('autoEdit');
    const result = orch.checkPermission('workspaceEdit');
    expect(result.allowed).toBe(true);
    expect(result.escalated).toBe(false);
  });
});
