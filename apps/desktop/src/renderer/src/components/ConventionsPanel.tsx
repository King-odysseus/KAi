
import { BookMarked, Check, FileCode2, Palette, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import { Switch } from './ui/Switch';
import { useEffect, useState, type ReactNode } from 'react';
import type { ConventionItem, ConventionsState, DesignProfileSummary } from '@kai/contracts';
import { unwrap } from '../types';
import { Pill } from './Pill';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

const GROUPS: ReadonlyArray<{ source: ConventionItem['source']; title: string; help: string; icon: typeof Wrench }> = [
  { source: 'style', title: 'How you want things to look', help: 'Read from the projects you marked as a style reference: buttons, cards, borders and shadows.', icon: Palette },
  { source: 'habit', title: 'What you usually build with', help: 'Tools and patterns that show up in several of your projects.', icon: Wrench },
];

function when(iso: string | null): string {
  if (!iso) return 'not yet';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * What C1 has learned about how this developer builds, and the controls over it. Every agent run is handed the ones
 * that are switched on, so a preference set here (or found in a project) is something an agent follows without being
 * told again.
 */
export function ConventionsPanel(): ReactNode {
  const [state, setState] = useState<ConventionsState | null>(null);
  const [profiles, setProfiles] = useState<DesignProfileSummary[]>([]);
  const [rule, setRule] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      window.kaiDesktop.conventionsState(false).then(unwrap),
      window.kaiDesktop.designProfilesState(true).then(unwrap),
    ]).then(([conventions, designProfiles]) => { setState(conventions); setProfiles(designProfiles); }).catch((caught) => setError(messageOf(caught)));
    const stop = window.kaiDesktop.onConventionsChanged(setState);
    return () => {
      stop();
      // Having looked at the list, nothing in it is new any more.
      void window.kaiDesktop.markConventionsSeen().catch(() => undefined);
    };
  }, []);

  async function act(action: () => Promise<{ ok: boolean }>): Promise<void> {
    setError(null);
    try { await action(); } catch (caught) { setError(messageOf(caught)); }
  }

  async function addRule(): Promise<void> {
    const text = rule.trim();
    if (!text) return;
    await act(async () => { const result = await window.kaiDesktop.addConventionRule(text); setState(unwrap(result)); setRule(''); return { ok: true }; });
  }

  async function approveProfile(profile: DesignProfileSummary): Promise<void> {
    await act(async () => {
      const updated = unwrap(await window.kaiDesktop.approveDesignProfile(profile.projectPath));
      setProfiles((current) => current.map((item) => item.projectPath === updated.projectPath ? updated : item));
      return { ok: true };
    });
  }

  if (!state) return <div className="empty-list">{error ?? 'Reading your projects…'}</div>;
  const served = state.items.filter((item) => !item.muted).length;
  const rules = state.items.filter((item) => item.source === 'rule');

  return (
    <section className="ops-panel conventions-panel">
      <div className="ops-actions">
        <Pill tone={state.scanning ? 'info' : 'success'}>{state.scanning ? 'Reading your projects…' : `Read ${state.total} projects · ${when(state.scannedAt)}`}</Pill>
        <UiButton type="button" className="secondary-button" onClick={() => void act(async () => { const [conventions, designProfiles] = await Promise.all([window.kaiDesktop.conventionsState(true), window.kaiDesktop.designProfilesState(true)]); setState(unwrap(conventions)); setProfiles(unwrap(designProfiles)); return { ok: true }; })}><RefreshCw size={14} /><span>Read my projects again</span></UiButton>
        <small>{served} {served === 1 ? 'convention is' : 'conventions are'} given to every agent run · {state.filedInC1} filed in C1. KAI checks again every 20 minutes.</small>
      </div>
      {error && <div className="workbench-error" role="alert">{error}</div>}

      <h3 className="crew-subheading"><FileCode2 size={13} /> Project design profiles</h3>
      <small className="crew-empty">KAI reads real component code. A profile stays a draft until you approve it here. Only approved profiles guide UI work.</small>
      {profiles.length === 0
        ? <small className="crew-empty">No starting projects were found. Open zurilofts, TijhaWebsite or tijhabooks to create a draft.</small>
        : <ul className="crew-spend">
          {profiles.map((profile) => (
            <li key={profile.projectPath}>
              <span>
                <strong>{profile.projectName}</strong> · {profile.status} · {profile.componentCount} components · score {profile.score}
                {profile.agentsPasteLine && <small className="crew-empty">For repository agents, add this line to AGENTS.md: {profile.agentsPasteLine}</small>}
              </span>
              {profile.status === 'draft' && <UiButton type="button" className="secondary-button" onClick={() => void approveProfile(profile)}><Check size={14} /><span>Approve profile</span></UiButton>}
            </li>
          ))}
        </ul>}

      <h3 className="crew-subheading">Your own rules</h3>
      <div className="conventions-add">
        <UiTextInput aria-label="A rule for every agent" value={rule} placeholder="For example: never use 1px hairline borders" onChange={(event) => setRule(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void addRule(); }} />
        <UiButton type="button" className="secondary-button" disabled={!rule.trim()} onClick={() => void addRule()}><Plus size={14} /><span>Add rule</span></UiButton>
      </div>
      {rules.length === 0 && <small className="crew-empty">None yet. A rule you write here is followed in every project.</small>}
      <ul className="crew-spend">
        {rules.map((item) => (
          <li key={item.key}>
            <span><BookMarked size={13} /> {item.text}</span>
            <span className="conventions-row-actions">
              <label className="conventions-serve"><Switch checked={!item.muted} onChange={(event) => void act(async () => { setState(unwrap(await window.kaiDesktop.muteConvention(item.key, !event.target.checked))); return { ok: true }; })} /><small>Serve</small></label>
              <UiButton type="button" className="icon-button" aria-label={`Remove rule: ${item.text}`} onClick={() => void act(async () => { setState(unwrap(await window.kaiDesktop.removeConventionRule(item.key.replace(/^rule:/, '')))); return { ok: true }; })}><Trash2 size={14} /></UiButton>
            </span>
          </li>
        ))}
      </ul>

      <h3 className="crew-subheading">Projects that show how you want it to look</h3>
      <small className="crew-empty">Tick a project whose design you like, for example your best one. What its buttons and cards do becomes the way agents write styles.</small>
      <ul className="crew-spend">
        {state.projects.map((project) => (
          <li key={project.path}>
            <span title={project.path}>{project.name}</span>
            <label className="conventions-serve"><Switch checked={project.reference} onChange={(event) => void act(async () => { setState(unwrap(await window.kaiDesktop.setConventionReference(project.path, event.target.checked))); return { ok: true }; })} /><small>Style reference</small></label>
          </li>
        ))}
        {state.projects.length === 0 && <small className="crew-empty">Open a project first.</small>}
      </ul>

      {GROUPS.map((group) => {
        const items = state.items.filter((item) => item.source === group.source);
        return (
          <div key={group.source}>
            <h3 className="crew-subheading"><group.icon size={13} /> {group.title}</h3>
            <small className="crew-empty">{group.help}</small>
            {items.length === 0
              ? <small className="crew-empty">{group.source === 'style' ? ' Nothing yet: mark a project above.' : ' Nothing found in two or more of your projects yet.'}</small>
              : (
                <ul className="crew-spend">
                  {items.map((item) => (
                    <li key={item.key}>
                      <span>{item.text}{item.isNew && <> <Pill tone="info">New</Pill></>}<small className="crew-empty"> · {item.evidence}</small></span>
                      <label className="conventions-serve"><Switch checked={!item.muted} onChange={(event) => void act(async () => { setState(unwrap(await window.kaiDesktop.muteConvention(item.key, !event.target.checked))); return { ok: true }; })} /><small>Serve</small></label>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        );
      })}
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
