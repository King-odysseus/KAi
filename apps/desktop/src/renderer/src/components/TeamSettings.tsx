import { agentTeamSchema, CLI_MODEL_SUGGESTIONS, DEFAULT_AUTO_ADD, MAX_CUSTOM_ROLES, TEAM_ROLE_INFO, TEAM_ROLE_IDS, roleAutoAdd, type AgentTeam, type CustomRole, type TeamAssignee, type TeamAutoAdd, type TeamPreset, type TeamRoleId, type TeamRouteChoice } from '@kai/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { TeamRecordAdvice, TeamResolvedAssignee } from '@kai/contracts';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';

import { ModelField } from './ModelField';
import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Textarea } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';
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

const AUTO_ADD_OPTIONS: Array<{ value: TeamAutoAdd; label: string }> = [
  { value: 'never', label: 'Only if the orchestrator plans it' },
  { value: 'sensitive', label: 'When the job touches sensitive areas' },
  { value: 'always', label: 'Every job' },
];

const MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/** Who plans and who does each part when a job is handed to the agent team. */
export function TeamSettings({ team, onChange, projectId }: { team: AgentTeam; onChange: (team: AgentTeam) => void; projectId?: string }): ReactNode {
  const preset = PRESETS.find((item) => item.id === team.preset) ?? PRESETS[1]!;
  const [advice, setAdvice] = useState<TeamRecordAdvice[]>([]);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [bundleFeedback, setBundleFeedback] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.kaiDesktop.teamRecord({ team, ...(projectId ? { projectId } : {}) }).then(unwrap).then((value) => {
        if (!cancelled) { setAdvice(value); setRecordError(null); }
      }).catch((error: unknown) => {
        if (!cancelled) setRecordError(error instanceof Error ? error.message : 'Could not read the track record.');
      });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [team, projectId, revision]);

  async function clearRecord(): Promise<void> {
    if (!(await confirmDialog({ title: 'Clear track record?', detail: 'Remove the local agent track record across all projects? Your team choices and conversations stay as they are.', confirmLabel: 'Clear track record', destructive: true }))) return;
    setClearing(true);
    try {
      unwrap(await window.kaiDesktop.clearTeamRecord());
      setAdvice([]);
      setRevision((value) => value + 1);
    } catch (error) {
      setRecordError(error instanceof Error ? error.message : 'Could not clear the track record.');
    } finally { setClearing(false); }
  }

  async function copyTeamBundle(): Promise<void> {
    const bundle = { format: 'kai-team-bundle', version: 1, team };
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setBundleFeedback('Team bundle copied. It contains role settings and instructions, but no credentials.');
    } catch {
      setBundleFeedback('Clipboard access is unavailable. Allow clipboard access and try again.');
    }
  }

  async function importTeamBundle(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await navigator.clipboard.readText());
      if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'kai-team-bundle'
        || !('version' in parsed) || parsed.version !== 1 || !('team' in parsed)) {
        throw new Error('This clipboard does not contain a supported KAI team bundle.');
      }
      const validated = agentTeamSchema.safeParse(parsed.team);
      if (!validated.success) throw new Error('The team bundle is invalid or uses a different KAI format.');
      onChange(validated.data);
      setBundleFeedback('Team bundle imported into the current settings draft. Save settings to keep it.');
    } catch (error) {
      setBundleFeedback(error instanceof Error ? error.message : 'Could not read the team bundle from the clipboard.');
    }
  }

  function update(role: TeamRoleId, patch: Partial<AgentTeam['roles'][TeamRoleId] & object>): void {
    const current = team.roles[role] ?? { assignee: 'auto' as const, route: 'auto' as const, instructions: '' };
    const next = { ...current, ...patch };
    if (next.model !== undefined && !next.model.trim()) delete next.model;
    onChange({ ...team, roles: { ...team.roles, [role]: next } });
  }

  function updateCustom(id: string, patch: Partial<CustomRole>): void {
    onChange({ ...team, custom: team.custom.map((role) => {
      if (role.id !== id) return role;
      const next = { ...role, ...patch };
      if (next.model !== undefined && !next.model.trim()) delete next.model;
      return next;
    }) });
  }

  function addCustom(): void {
    // The id is fixed here and never follows the name, so renaming a role later cannot orphan a plan.
    let id = 'custom-new-role';
    for (let count = 2; team.custom.some((role) => role.id === id); count += 1) id = `custom-new-role-${count}`;
    onChange({ ...team, custom: [...team.custom, { id, label: 'New role', description: '', access: 'edit', assignee: 'auto', route: 'auto', instructions: '' }] });
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
          <Select aria-label="Team preset" value={team.preset} onChange={(event) => onChange({ ...team, preset: event.target.value as TeamPreset })}>
            {PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
        </label>
      </div>
      <p className="settings-note team-preset-detail">{preset.detail} A preset only guides Auto; a role you pin always keeps your choice.</p>
      <div className="button-row align-start">
        <UiButton type="button" className="secondary-button" disabled={clearing} onClick={() => void clearRecord()}>Clear track record</UiButton>
      </div>
      <div className="button-row align-start">
        <UiButton type="button" className="secondary-button" onClick={() => void copyTeamBundle()}>Copy team bundle</UiButton>
        <UiButton type="button" className="secondary-button" onClick={() => void importTeamBundle()}>Import team bundle</UiButton>
      </div>
      {bundleFeedback && <p className="settings-note" role="status">{bundleFeedback}</p>}
      {recordError && <p className="settings-feedback error" role="alert">{recordError}</p>}
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
              <RoleTrackRecord advice={advice.find((item) => item.role === role)} scope={projectId ?? 'all'} onUse={(assignee) => { update(role, { assignee }); }} />
              <div className="field-grid">
                <label className="field">
                  <span>Agent</span>
                  <Select aria-label={`${info.label} agent`} value={config.assignee} onChange={(event) => update(role, { assignee: event.target.value as TeamAssignee })}>
                    {TEAM_AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <label className="field">
                  <span>Route</span>
                  <Select aria-label={`${info.label} route`} value={config.route} onChange={(event) => update(role, { route: event.target.value as TeamRouteChoice })}>
                    {ROUTE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <ModelField label="Model" value={config.model ?? ''} models={suggestions} emptyLabel="Agent default" error={modelInvalid ? 'Use a model name such as the ones listed, without spaces or a leading dash.' : undefined} onChange={(value) => update(role, { model: value.trim() })} />
                {role !== 'orchestrator' && (
                  <label className="field">
                    <span>Added to a job</span>
                    <Select aria-label={`${info.label} added to a job`} value={roleAutoAdd(config, role)} onChange={(event) => update(role, { autoAdd: event.target.value as TeamAutoAdd })}>
                      {AUTO_ADD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}{DEFAULT_AUTO_ADD[role] === option.value ? ' (default)' : ''}</option>)}
                    </Select>
                  </label>
                )}
              </div>
              <label className="field">
                <span>Extra instructions</span>
                <Textarea aria-label={`${info.label} instructions`} rows={2} maxLength={2000} value={config.instructions} placeholder={role === 'securityReviewer' ? 'For example: check the OWASP Top 10 and flag any secret in code.' : 'Optional guidance added to every task this role gets.'} onChange={(event) => update(role, { instructions: event.target.value })} />
              </label>
            </fieldset>
          );
        })}
      </div>
      <div className="team-custom">
        <div className="team-custom-head">
          <strong>Your own roles</strong>
          <UiButton type="button" className="secondary-button" disabled={team.custom.length >= MAX_CUSTOM_ROLES} onClick={addCustom}>
            <Plus size={14} /><span>Add a role</span>
          </UiButton>
        </div>
        <p className="settings-note">A role for work the built-in seven do not cover, such as a database specialist or an accessibility auditor. The orchestrator can plan parts for it; you decide whether it edits files or only reads.</p>
        {team.custom.map((role) => {
          const modelInvalid = Boolean(role.model) && (role.model!.length > 100 || !MODEL_PATTERN.test(role.model!));
          const suggestions = role.assignee !== 'auto' && role.assignee !== 'api' ? CLI_MODEL_SUGGESTIONS[role.assignee] : [];
          return (
            <fieldset className="team-role" key={role.id}>
              <legend>
                <strong>{role.label.trim() || 'Unnamed role'}</strong>
                <span className={`team-access ${role.access}`}>{role.access === 'read' ? 'Read-only' : 'Edits files'}</span>
              </legend>
              <div className="field-grid">
                <label className="field">
                  <span>Name</span>
                  <UiTextInput aria-label={`${role.id} name`} value={role.label} maxLength={60} aria-invalid={!role.label.trim()} onChange={(event) => updateCustom(role.id, { label: event.target.value })} />
                  {!role.label.trim() && <small className="field-error">Give the role a name.</small>}
                </label>
                <label className="field">
                  <span>Access</span>
                  <Select aria-label={`${role.label} access`} value={role.access} onChange={(event) => updateCustom(role.id, { access: event.target.value as CustomRole['access'] })}>
                    <option value="edit">Edits files</option>
                    <option value="read">Read-only</option>
                  </Select>
                </label>
                <label className="field">
                  <span>What it does</span>
                  <UiTextInput aria-label={`${role.label} description`} value={role.description} maxLength={300} placeholder="Shown to the orchestrator" onChange={(event) => updateCustom(role.id, { description: event.target.value })} />
                </label>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>Agent</span>
                  <Select aria-label={`${role.label} agent`} value={role.assignee} onChange={(event) => updateCustom(role.id, { assignee: event.target.value as TeamAssignee })}>
                    {TEAM_AGENT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <label className="field">
                  <span>Route</span>
                  <Select aria-label={`${role.label} route`} value={role.route} onChange={(event) => updateCustom(role.id, { route: event.target.value as TeamRouteChoice })}>
                    {ROUTE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <ModelField label="Model" value={role.model ?? ''} models={suggestions} emptyLabel="Agent default" error={modelInvalid ? 'Use a model name such as the ones listed, without spaces or a leading dash.' : undefined} onChange={(value) => updateCustom(role.id, { model: value.trim() })} />
              </div>
              <label className="field">
                <span>Extra instructions</span>
                <Textarea aria-label={`${role.label} instructions`} rows={2} maxLength={2000} value={role.instructions} placeholder="Optional guidance added to every task this role gets." onChange={(event) => updateCustom(role.id, { instructions: event.target.value })} />
              </label>
              <div className="team-custom-actions">
                <UiButton type="button" className="secondary-button" onClick={() => onChange({ ...team, custom: team.custom.filter((item) => item.id !== role.id) })}>
                  <Trash2 size={14} /><span>Remove this role</span>
                </UiButton>
              </div>
              <RoleTrackRecord advice={advice.find((item) => item.role === role.id)} scope={projectId ?? 'all'} onUse={(assignee) => { updateCustom(role.id, { assignee }); }} />
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The team card: the team from Settings, or a team just for the open project. A project team starts as a copy of
 * the Settings team and from then on stands alone; removing it returns the project to the Settings team.
 */
export function AgentTeamCard({
  globalTeam,
  onGlobalChange,
  globalSaveSlot,
  project,
  projectTeam,
  onSaveProjectTeam,
  busy,
}: {
  globalTeam: AgentTeam;
  onGlobalChange: (team: AgentTeam) => void;
  globalSaveSlot: ReactNode;
  project: { id: string; name: string } | null;
  projectTeam: AgentTeam | null;
  onSaveProjectTeam: (team: AgentTeam | null) => Promise<boolean>;
  busy: boolean;
}): ReactNode {
  const [scope, setScope] = useState<'all' | 'project'>('all');
  const [draft, setDraft] = useState<AgentTeam | null>(projectTeam);
  const [saving, setSaving] = useState(false);
  const projectId = project?.id ?? null;
  const savedJson = JSON.stringify(projectTeam);

  // Follow what is saved: a different project, or the result of a save, replaces the working copy.
  useEffect(() => {
    setDraft(projectTeam);
    if (!projectId) setScope('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, savedJson]);

  const dirty = JSON.stringify(draft) !== savedJson;

  async function save(next: AgentTeam | null): Promise<void> {
    setSaving(true);
    try {
      await onSaveProjectTeam(next);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="team-scope">
      <div className="team-scope-tabs" role="tablist" aria-label="Which team to edit">
        <UiButton type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All projects</UiButton>
        <UiButton type="button" role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'active' : ''} disabled={!project} title={project ? undefined : 'Open a project to give it its own team'} onClick={() => setScope('project')}>
          {project ? `Just ${project.name}` : 'One project'}
        </UiButton>
      </div>
      {scope === 'all' && (
        <>
          <TeamSettings team={globalTeam} onChange={onGlobalChange} projectId={projectId ?? undefined} />
          {globalSaveSlot}
        </>
      )}
      {scope === 'project' && project && (draft
        ? (
          <>
            <p className="settings-note">{project.name} has its own team. Plans for this project use it instead of the team from Settings.</p>
            <TeamSettings team={draft} onChange={setDraft} projectId={project.id} />
            <div className="button-row align-start">
              <UiButton type="button" className="primary-button" disabled={busy || saving || !dirty} onClick={() => void save(draft)}>
                <span>{saving ? 'Saving' : `Save the team for ${project.name}`}</span>
              </UiButton>
              <UiButton type="button" className="secondary-button" disabled={busy || saving || !projectTeam} onClick={() => void save(null)}>
                <span>Use the team from Settings again</span>
              </UiButton>
              {!projectTeam && <UiButton type="button" className="secondary-button" disabled={saving} onClick={() => setDraft(null)}><span>Discard</span></UiButton>}
            </div>
          </>
        )
        : (
          <div className="team-scope-empty">
            <p className="settings-note">{project.name} uses the team from Settings. Give it its own team when this project needs different agents or roles.</p>
            <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(structuredClone(globalTeam))}>
              <span>Create a team for {project.name}</span>
            </UiButton>
          </div>
        ))}
    </div>
  );
}

function RoleTrackRecord({ advice, scope, onUse }: { advice?: TeamRecordAdvice; scope: string; onUse: (assignee: TeamResolvedAssignee) => void }): ReactNode {
  const key = `kai.teamSuggestion.${scope}.${advice?.role ?? ''}`;
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    try { setDismissed(window.localStorage.getItem(key) ?? ''); }
    catch { setDismissed(''); }
  }, [key]);
  if (!advice) return null;
  const name = (assignee: TeamResolvedAssignee): string => TEAM_AGENT_OPTIONS.find((option) => option.value === assignee)?.label ?? assignee;
  const suggestion = advice.suggestion;
  return <div className="team-track-record">
    {advice.records.map((record) => {
      const text = `${name(record.assignee)}: ${record.jobs} ${record.jobs === 1 ? 'job' : 'jobs'}, ${record.passed} passed first time, about ${Math.max(1, Math.round(record.medianDurationMs / 60_000))} min each (${record.scope === 'project' ? 'here' : 'all projects'})`;
      return <p key={record.assignee} className="team-track-record-line" title={text}>{text}</p>;
    })}
    {suggestion && suggestion.fingerprint !== dismissed && <div className="team-track-suggestion">
      <p className="settings-note">{suggestion.text}</p>
      <div className="button-row align-start">
        <UiButton type="button" className="secondary-button" onClick={() => { onUse(suggestion.assignee); }}>Use {name(suggestion.assignee)}</UiButton>
        <UiButton type="button" className="secondary-button" onClick={() => {
          setDismissed(suggestion.fingerprint);
          try { window.localStorage.setItem(key, suggestion.fingerprint); } catch { /* The in-memory dismissal still works when storage is unavailable. */ }
        }}>Dismiss</UiButton>
      </div>
    </div>}
  </div>;
}
