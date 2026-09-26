import { CLI_MODEL_SUGGESTIONS, TEAM_ROLE_INFO, TEAM_ROLE_IDS, type AgentTeam, type TeamAssignee, type TeamPreset, type TeamRoleId, type TeamRouteChoice } from '@kai/contracts';
import type { ReactNode } from 'react';

const PRESETS: Array<{ id: TeamPreset; label: string; detail: string }> = [
  { id: 'quality', label: 'Quality', detail: 'The strongest ready agent for every role, whatever the limits.' },
  { id: 'balanced', label: 'Balanced', detail: 'Strong agents where it matters; lighter ones for tests and docs to save your Claude and Codex limits.' },
  { id: 'budget', label: 'Budget', detail: 'Keeps Claude and Codex for the hardest parts and uses the others wherever they are good enough.' },
];

export const TEAM_AGENT_OPTIONS: Array<{ value: TeamAssignee; label: string }> = [
  { value: 'auto', label: 'Auto (KAI decides)' },
  { value: 'api', label: 'KAI API mode' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'qwen', label: 'Qwen Code' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'kimi', label: 'Kimi Code' },
];

const ROUTE_OPTIONS: Array<{ value: TeamRouteChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'direct', label: 'Direct' },
  { value: 'proxy', label: 'Proxy' },
];

const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/** Who plans and who does each part when a job is handed to the agent team. */
export function TeamSettings({ team, onChange }: { team: AgentTeam; onChange: (team: AgentTeam) => void }): ReactNode {
  const preset = PRESETS.find((item) => item.id === team.preset) ?? PRESETS[1]!;

  function update(role: TeamRoleId, patch: Partial<AgentTeam['roles'][TeamRoleId] & object>): void {
    const current = team.roles[role] ?? { assignee: 'auto' as const, route: 'auto' as const, instructions: '' };
    const next = { ...current, ...patch };
    if (next.model !== undefined && !next.model.trim()) delete next.model;
    onChange({ ...team, roles: { ...team.roles, [role]: next } });
  }

  return (
    <div className="team-settings">
      <p className="settings-note">
        Pick who does each job, or leave a role on <strong>Auto</strong> and KAI chooses from the agents that are ready.
        Reviewers only read: they report problems but never change your files, and they are never the agent that wrote the code when another is ready.
      </p>
      <div className="field-grid">
        <label className="field">
          <span>Preset</span>
          <select aria-label="Team preset" value={team.preset} onChange={(event) => onChange({ ...team, preset: event.target.value as TeamPreset })}>
            {PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
      </div>
      <p className="settings-note team-preset-detail">{preset.detail} A preset only guides Auto; a role you pin always keeps your choice.</p>
      <div className="team-roles">
        {TEAM_ROLE_IDS.map((role) => {
          const info = TEAM_ROLE_INFO[role];
          const config = team.roles[role] ?? { assignee: 'auto' as const, route: 'auto' as const, instructions: '' };
          const modelInvalid = Boolean(config.model) && (config.model!.length > 100 || !MODEL_PATTERN.test(config.model!));
          const suggestions = config.assignee !== 'auto' && config.assignee !== 'api' ? CLI_MODEL_SUGGESTIONS[config.assignee] : [];
          return (
            <fieldset className="team-role" key={role}>
              <legend>
                <strong>{info.label}</strong>
                <span className={`team-access ${info.access}`}>{info.access === 'read' ? 'Read-only' : 'Edits files'}</span>
              </legend>
              <p className="team-role-detail">{info.description}</p>
              <div className="field-grid">
                <label className="field">
                  <span>Agent</span>
                  <select aria-label={`${info.label} agent`} value={config.assignee} onChange={(event) => update(role, { assignee: event.target.value as TeamAssignee })}>
                    {TEAM_AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Route</span>
                  <select aria-label={`${info.label} route`} value={config.route} onChange={(event) => update(role, { route: event.target.value as TeamRouteChoice })}>
                    {ROUTE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <input aria-label={`${info.label} model`} value={config.model ?? ''} placeholder="Agent default" list={`team-models-${role}`} aria-invalid={modelInvalid} onChange={(event) => update(role, { model: event.target.value.trim() })} />
                  <datalist id={`team-models-${role}`}>{suggestions.map((name) => <option key={name} value={name} />)}</datalist>
                  {modelInvalid && <small className="field-error">Use a model name such as gpt-5.5, without spaces or a leading dash.</small>}
                </label>
              </div>
              <label className="field">
                <span>Extra instructions</span>
                <textarea aria-label={`${info.label} instructions`} rows={2} maxLength={2000} value={config.instructions} placeholder={role === 'securityReviewer' ? 'For example: check the OWASP Top 10 and flag any secret in code.' : 'Optional guidance added to every task this role gets.'} onChange={(event) => update(role, { instructions: event.target.value })} />
              </label>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
