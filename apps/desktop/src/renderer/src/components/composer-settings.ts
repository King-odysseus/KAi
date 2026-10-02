import type { AgentId, AutonomyMode, ExecutionMode, RouteMode } from '@kai/contracts';

/**
 * The four choices the composer makes about how a run is made: who runs it, how, by which route, and how much it may
 * do without asking.
 *
 * They are the person's, and the rule they follow is theirs: **a choice stays until the person changes it**. Nothing
 * else — opening a conversation, a run finishing, another screen being visited — may quietly move them, which is what
 * happened twice: the composer reset to CLI and Ask whenever a conversation was opened, and a conversation that had
 * never been run was treated as having no opinion at all.
 */
export interface ComposerSettings {
  agent: AgentId;
  execution: ExecutionMode;
  route: RouteMode;
  autonomy: AutonomyMode;
}

/** What a conversation remembers about how it was last run. Any of it may be missing. */
export type RecordedSettings = Partial<ComposerSettings>;

/**
 * What the composer should show for a conversation, in order of who has the last word.
 *
 * 1. **The person's choice for this conversation**, if they have made one — not merely the same thing most recently,
 *    but a real decision about this thread, which is exactly what must survive a screen change or a silent reopen.
 * 2. **What the conversation's record says it ran with**, for a thread whose choices were made elsewhere (a CLI
 *    session, a schedule) and which the composer has never been told about.
 * 3. **What the composer shows now**, for a record with no opinion — the mistake this replaces was filling that gap
 *    with the app's defaults, which moved a chosen API run back to CLI in front of the person starting it.
 */
export function composerSettingsFor(input: {
  stored?: RecordedSettings | undefined;
  recorded?: RecordedSettings | undefined;
  current: ComposerSettings;
}): ComposerSettings {
  const pick = <K extends keyof ComposerSettings>(key: K): ComposerSettings[K] =>
    input.stored?.[key] ?? input.recorded?.[key] ?? input.current[key];
  return {
    agent: pick('agent'),
    execution: pick('execution'),
    route: pick('route'),
    autonomy: pick('autonomy'),
  };
}
