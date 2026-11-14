import { useState, type ReactNode } from 'react';
import type { ExecutionMode } from '@kai/contracts';
import { readAutoSettings, writeAutoSettings, type AutoSettings } from './auto-settings';
import { UiTextInput } from './UiTextInput';
import { Select } from './ui/Select';

interface Props {
  projectId: string | null;
  /** The mode the composer is set to, which is what the provider note below is about. */
  execution: ExecutionMode;
  /** True while an Auto run is going, when none of these are what the run in flight is using. */
  running: boolean;
}

/**
 * Auto's tuning — what the next send will start with.
 *
 * This was a standing panel above the composer, carrying the run's status, its log and these fields all at once, and
 * it sat there whether or not Auto was ever used. The status and the log now live on the composer's run line, where
 * they are worth reading at a glance; what is left is the settings, which are only wanted on the rare occasion
 * someone goes looking, so they are shown behind that line rather than beside the message box.
 *
 * It never had a launcher and still does not: the task goes in the composer and the composer's send starts the run,
 * so the same text cannot have two places to start from.
 */
export function AutoSettings({ projectId, execution, running }: Props): ReactNode {
  const [settings, setSettings] = useState<AutoSettings>(() => readAutoSettings(projectId));
  const update = (change: Partial<AutoSettings>): void => {
    setSettings((current) => {
      const next = { ...current, ...change };
      if (projectId) writeAutoSettings(projectId, next);
      return next;
    });
  };

  return (
    <div className="auto-settings">
      <p className="studio-note">
        Auto works the task sent in the composer, one turn after another, until the agent&rsquo;s own plan is done —
        the plan the run keeps in <code>.kai/plan.json</code>. The check command is then run to confirm it, and a
        failure goes straight back to the agent.
      </p>
      {running ? (
        <p className="studio-note">These are what the next run starts with. The one in flight is using what it started with.</p>
      ) : (
        <div className="autopilot-fields">
          <label>
            <span>Check command</span>
            <UiTextInput value={settings.checkCommand} onChange={(event) => update({ checkCommand: event.target.value })} placeholder="Blank: the project's test command, when it has one" />
          </label>
          {execution === 'cli' && (
            <label>
              <span>When the CLI window is spent</span>
              <Select value={settings.apiFallback ? 'api' : 'wait'} onChange={(event) => update({ apiFallback: event.target.value === 'api' })}>
                <option value="api">Carry on with the API provider, then return to the CLI</option>
                <option value="wait">Wait for the CLI window to reopen</option>
              </Select>
            </label>
          )}
          <label>
            <span>Most turns (0 = no limit)</span>
            <UiTextInput type="number" min={0} max={500} value={settings.maxTurns} onChange={(event) => update({ maxTurns: Math.min(500, Math.max(0, Number(event.target.value) || 0)) })} />
          </label>
          <label>
            <span>Stop after (hours, 0 = never)</span>
            <UiTextInput type="number" min={0} max={168} value={settings.maxHours} onChange={(event) => update({ maxHours: Math.min(168, Math.max(0, Number(event.target.value) || 0)) })} />
          </label>
          <label>
            <span>Stop at spend (USD, 0 = no limit)</span>
            <UiTextInput type="number" min={0} step={1} value={settings.maxCostUsd} onChange={(event) => update({ maxCostUsd: Math.max(0, Number(event.target.value) || 0) })} />
          </label>
          <label>
            <span>Seconds between API requests</span>
            <UiTextInput type="number" min={0} max={120} value={settings.minGapSeconds} onChange={(event) => update({ minGapSeconds: Math.min(120, Math.max(0, Number(event.target.value) || 0)) })} />
          </label>
        </div>
      )}
      <p className="studio-note">A cap parks the run for you to raise, rather than ending it. The agent&rsquo;s own plan is what closes the task; the check command confirms it once the plan is done.</p>
    </div>
  );
}
