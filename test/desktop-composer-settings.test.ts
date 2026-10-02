import { describe, expect, it } from 'vitest';
import { composerSettingsFor } from '../apps/desktop/src/renderer/src/components/composer-settings';

/**
 * Who has the last word on how a run is made.
 *
 * This has reset on the person twice: the composer went back to CLI and Ask when a conversation was opened, and a
 * conversation with no opinion of its own was filled from the app's defaults rather than left alone. The rule they
 * asked for is one line — a choice stays until they change it — and this is where it is kept.
 */

const current = { agent: 'claude', execution: 'api', route: 'proxy', autonomy: 'full' } as const;

describe('how the composer decides what to show', () => {
  it('keeps the choice the person made in this conversation, whatever the record says', () => {
    // The regression: they set API + Full access, the conversation was reopened (from a tab, from the Studio, from
    // Auto making its own) and the record — last run on the CLI, at Plan — put the composer back.
    const settings = composerSettingsFor({
      stored: { agent: 'claude', execution: 'api', route: 'direct', autonomy: 'full' },
      recorded: { agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'plan' },
      current,
    });
    expect(settings).toEqual({ agent: 'claude', execution: 'api', route: 'direct', autonomy: 'full' });
  });

  it('takes what the record says when the person has not chosen in that conversation', () => {
    // A thread made elsewhere — a CLI session, a schedule, the board — has settings the composer has never seen.
    const settings = composerSettingsFor({
      recorded: { agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'autoEdit' },
      current,
    });
    expect(settings).toEqual({ agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'autoEdit' });
  });

  it('leaves the composer as the person left it when the record says nothing', () => {
    expect(composerSettingsFor({ recorded: {}, current })).toEqual(current);
    expect(composerSettingsFor({ current })).toEqual(current);
  });

  it('fills only the fields it was actually given', () => {
    // A stored choice that names one thing does not wipe the other three: the rest fall through to the record.
    const settings = composerSettingsFor({
      stored: { autonomy: 'full' },
      recorded: { agent: 'codex', execution: 'cli' },
      current,
    });
    expect(settings).toEqual({ agent: 'codex', execution: 'cli', route: 'proxy', autonomy: 'full' });
  });
});
