import { describe, expect, it } from 'vitest';
import { HELPER_CHOICES, HELPER_CHOICE_DESCRIPTION, HELPER_CHOICE_LABEL, agentRunRequestSchema, helperChoiceSchema, helperLimitOf } from '../packages/contracts/src';
import { helpersBriefing } from '../apps/desktop/src/main/working-method';

const request = { conversationId: 'c1', prompt: 'Build it', agent: 'codex', route: 'direct', autonomy: 'autoEdit' } as const;

describe('the composer\'s Agents choice', () => {
  it('is auto, off, or a number of helpers up to eight, and nothing else', () => {
    expect([...HELPER_CHOICES]).toEqual(['auto', 'off', '2', '3', '4', '5', '6', '8']);
    expect(helperChoiceSchema.safeParse('4').success).toBe(true);
    expect(helperChoiceSchema.safeParse('9').success).toBe(false);
    expect(helperChoiceSchema.safeParse('lots').success).toBe(false);
    expect(helperChoiceSchema.safeParse(4).success).toBe(false);
  });

  it('has a label and a plain description for every choice', () => {
    for (const choice of HELPER_CHOICES) {
      expect(HELPER_CHOICE_LABEL[choice]).toMatch(/^Agents: /);
      expect(HELPER_CHOICE_DESCRIPTION[choice].length).toBeGreaterThan(10);
    }
  });

  it('says how many helpers a choice allows: none for off, a number for a number, and no limit for auto', () => {
    expect(helperLimitOf(undefined)).toBeNull();
    expect(helperLimitOf('auto')).toBeNull();
    expect(helperLimitOf('off')).toBe(0);
    expect(helperLimitOf('2')).toBe(2);
    expect(helperLimitOf('8')).toBe(8);
  });

  it('rides on a run request, and a request without it is still valid', () => {
    expect(agentRunRequestSchema.parse({ ...request, helpers: '3' }).helpers).toBe('3');
    expect(agentRunRequestSchema.parse(request).helpers).toBeUndefined();
    expect(() => agentRunRequestSchema.parse({ ...request, helpers: '12' })).toThrow();
  });
});

describe('what the agent is told about helpers', () => {
  it('tells an agent on auto to split a large job with separate parts, and to do a small one itself', () => {
    const text = helpersBriefing('auto', 'api');
    expect(text).toContain('large');
    expect(text).toContain('separate parts');
    expect(text).toContain('small job');
    expect(text).toContain('Never give two helpers the same file');
    // An agent given no choice is on auto.
    expect(helpersBriefing(undefined, 'api')).toBe(text);
  });

  it('tells an agent that was given a number to use up to that many, in one turn', () => {
    const text = helpersBriefing('4', 'api');
    expect(text).toContain('up to 4 helper agents at once');
    expect(text).toContain('in the same turn');
    expect(text).toContain('Check the helpers');
  });

  it('tells an agent on 1 to do everything itself', () => {
    const text = helpersBriefing('off', 'api');
    expect(text).toContain('Do all the work yourself');
    expect(text).not.toContain('`task`');
  });

  it('names the task tool and write for an API run, and sub-agents for a CLI run', () => {
    const api = helpersBriefing('3', 'api');
    expect(api).toContain('`task` tool');
    expect(api).toContain('write to true');
    const cli = helpersBriefing('3', 'cli');
    expect(cli).toContain('sub-agents');
    expect(cli).not.toContain('`task` tool');
  });
});
