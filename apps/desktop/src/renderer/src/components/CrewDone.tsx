import { Textarea } from 'flowbite-react';
import { ArrowRight, ArrowUp, Check, FileText, MessageSquare, GitBranch, GitCommitHorizontal, Loader2, Eye, Send } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildReport } from '@kai/contracts';
import type { CrewRun, GitOverview, ProjectRecord } from '@kai/contracts';
import { draftCommitMessage } from '../crew-commit';
import { unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { Switch } from './ui/Switch';
import { UiButton } from './UiButton';

/** Things people ask for next, so the follow-up box is never an empty page. */
const SUGGESTIONS = [
  'Build and install it, then tell me how to run it.',
  'Fix everything in the open risks.',
  'Add tests for what was just built.',
  'Explain what was built and how to use it.',
];

/**
 * What a finished crew leaves behind: what was made, the next things to do with it, and a box to ask for more.
 *
 * The "Done" badge alone said the crew had stopped, not what it had produced or what to do next. The summary comes
 * from the same report the Report tab shows; the buttons do the same few things every time without a model; and
 * the box hands anything else to the Lead, which plans it onto this same board.
 */
export function CrewDone({ run, project, onFollowUp, onOpenGit, onPreview, onReport, onKeepGoing, onChat }: {
  run: CrewRun;
  project: ProjectRecord | null;
  onFollowUp: (prompt: string) => Promise<void>;
  onOpenGit?: () => void;
  onPreview?: () => void;
  onReport: () => void;
  /** Tells the crew to carry on through every phase, or to stop after each. */
  onKeepGoing: (on: boolean) => Promise<void>;
  /** Opens the Chat tab, where the Lead can be asked about what was done. */
  onChat: () => void;
}): ReactNode {
  const report = useMemo(() => buildReport(run), [run]);
  const files = useMemo(() => [...new Set(run.tasks.filter((task) => !task.proposed).flatMap((task) => task.files))], [run.tasks]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  async function send(text: string): Promise<void> {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await onFollowUp(value);
      setPrompt('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="ops-panel crew-done" aria-label="What the crew finished">
      <h2>{run.status === 'completed' ? 'Finished' : 'Stopped'}: {run.remaining.length > 0 ? `${report.totals.accepted} planned ${report.totals.accepted === 1 ? 'task' : 'tasks'} accepted. The plan is not finished.` : report.headline}</h2>
      <p className="tasks-tab-help">
        {report.totals.accepted} of {report.totals.tasks} tasks accepted · {report.totals.files} files changed · ${report.totals.costUsd.toFixed(2)} · {report.totals.minutes} min
      </p>

      {run.remaining.length > 0 && (
        <div className="crew-remaining" role="status">
          <strong>Not finished yet</strong>
          <ul className="crew-list">{run.remaining.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
          <div className="studio-actions">
            <UiButton type="button" className="primary-button" disabled={sending} onClick={() => void send(`Continue the plan with the next unfinished part: ${run.remaining[0]}.`)}>
              <ArrowRight size={14} /> Start the next phase
            </UiButton>
          </div>
          <label className="toggle-row"><span><strong>Keep going through every phase</strong><small>The crew plans each next phase itself and stops only for a security block, a limit, or a question only you can answer.</small></span><Switch checked={run.keepGoing} onChange={(event) => void onKeepGoing(event.target.checked).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))} /></label>
        </div>
      )}

      <h3 className="crew-subheading">What was made</h3>
      {report.built.length === 0
        ? <small className="crew-empty">Nothing was accepted.</small>
        : <ul className="crew-list">{report.built.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}
      {files.length > 0 && (
        <details className="crew-done-files">
          <summary>{files.length} {files.length === 1 ? 'file' : 'files'} changed</summary>
          <ul className="crew-list">{files.slice(0, 80).map((file) => <li key={file}><code>{file}</code></li>)}{files.length > 80 && <li>and {files.length - 80} more</li>}</ul>
        </details>
      )}
      {report.openRisks.length > 0 && (
        <>
          <h3 className="crew-subheading">Open risks</h3>
          <ul className="crew-list">{report.openRisks.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
        </>
      )}

      <h3 className="crew-subheading">Next</h3>
      <div className="studio-actions crew-done-actions">
        <UiButton type="button" className="secondary-button" onClick={onOpenGit} disabled={!onOpenGit || !project} title="Open Git to read every changed file"><GitBranch size={14} /> Review changes</UiButton>
        <UiButton type="button" className="secondary-button" onClick={onPreview} disabled={!onPreview || !project} title="Open the live preview pane"><Eye size={14} /> Preview</UiButton>
        <UiButton type="button" className={committing ? 'primary-button' : 'secondary-button'} onClick={() => setCommitting((open) => !open)} disabled={!project} aria-expanded={committing}><GitCommitHorizontal size={14} /> Commit and push</UiButton>
        <UiButton type="button" className="secondary-button" onClick={onReport}><FileText size={14} /> Full report</UiButton>
        <UiButton type="button" className="secondary-button" onClick={onChat} title="Ask the Lead what was done, or what is blocking the rest"><MessageSquare size={14} /> Ask the Lead</UiButton>
      </div>
      {committing && project && <CommitPanel project={project} built={report.built} onClose={() => setCommitting(false)} />}

      <h3 className="crew-subheading">Ask the crew for more</h3>
      <p className="tasks-tab-help">The Lead plans it onto this board with the same team, so nothing already built is redone.</p>
      <div className="command-chip-row" role="group" aria-label="Suggested follow-ups">
        {SUGGESTIONS.map((suggestion) => <UiButton key={suggestion} type="button" onClick={() => setPrompt(suggestion)} disabled={sending}>{suggestion}</UiButton>)}
      </div>
      <Textarea
        rows={3}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(prompt); } }}
        placeholder="For example: install it, then add a dark mode toggle."
        aria-label="Follow-up for the crew"
        maxLength={2000}
        disabled={sending}
      />
      <div className="studio-actions">
        <UiButton type="button" className="primary-button" onClick={() => void send(prompt)} disabled={sending || !prompt.trim()}>
          {sending ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Send to the Lead
        </UiButton>
        <small className="crew-empty">Ctrl+Enter to send</small>
      </div>
      {error && <p className="studio-notice error" role="alert">{error}</p>}
    </section>
  );
}

/**
 * Commit, then push, as two separate and visible steps. Committing stages every changed file in the project, so the
 * files are listed first; pushing sends work off this machine, so it asks before it does.
 */
function CommitPanel({ project, built, onClose }: { project: ProjectRecord; built: readonly string[]; onClose: () => void }): ReactNode {
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [message, setMessage] = useState(() => draftCommitMessage(built));
  const [busy, setBusy] = useState<string | null>('Reading the project');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setOverview(unwrap(await window.kaiDesktop.gitOverview(project.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => { void refresh(); }, [project.id]);

  async function commit(): Promise<void> {
    if (!overview || !message.trim()) return;
    setBusy('Committing');
    setError(null);
    setNotice(null);
    try {
      unwrap(await window.kaiDesktop.gitStage(project.id, overview.changes.map((change) => change.path), true));
      unwrap(await window.kaiDesktop.gitCommit(project.id, message.trim()));
      setNotice(`Committed ${overview.changes.length} ${overview.changes.length === 1 ? 'file' : 'files'}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The commit failed.');
    } finally {
      await refresh();
    }
  }

  async function push(): Promise<void> {
    if (!overview) return;
    const target = overview.githubRepository ? `origin (${overview.githubRepository})` : 'the remote';
    const confirmed = await confirmDialog({
      title: 'Push this branch?',
      detail: `Push "${overview.branch}" to ${target}?\n\nThis sends ${overview.ahead > 0 ? `${overview.ahead} commit${overview.ahead === 1 ? '' : 's'}` : 'the branch'} off this machine. KAI never force-pushes.`,
      confirmLabel: 'Push branch',
    });
    if (!confirmed) return;
    setBusy('Pushing');
    setError(null);
    setNotice(null);
    try {
      unwrap(await window.kaiDesktop.gitSync(project.id, 'push'));
      setNotice('Pushed.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The push failed.');
    } finally {
      await refresh();
    }
  }

  const changed = overview?.changes.length ?? 0;
  const canPush = Boolean(overview && overview.branch && overview.remotes.length > 0 && (overview.upstream === null || overview.ahead > 0));
  return (
    <div className="crew-commit" role="group" aria-label="Commit and push">
      {busy && <p className="studio-note"><Loader2 className="spin" size={13} /> {busy}…</p>}
      {overview && (
        <p className="studio-note">
          Branch <strong>{overview.branch ?? 'none'}</strong> · {changed} changed {changed === 1 ? 'file' : 'files'}
          {overview.ahead > 0 && <> · {overview.ahead} to push</>}
          {changed > 0 && <>. Committing includes every changed file in the project, not only the crew's.</>}
        </p>
      )}
      {changed > 0 && (
        <details>
          <summary>Files that will be committed</summary>
          <ul className="crew-list">{overview!.changes.slice(0, 60).map((change) => <li key={change.path}><code>{change.path}</code></li>)}{changed > 60 && <li>and {changed - 60} more</li>}</ul>
        </details>
      )}
      <Textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Commit message" disabled={busy !== null} />
      <div className="studio-actions">
        <UiButton type="button" className="primary-button" onClick={() => void commit()} disabled={busy !== null || changed === 0 || !message.trim()}><GitCommitHorizontal size={14} /> Commit {changed > 0 ? `${changed} ${changed === 1 ? 'file' : 'files'}` : ''}</UiButton>
        <UiButton type="button" className="secondary-button" onClick={() => void push()} disabled={busy !== null || !canPush} title={overview && overview.remotes.length === 0 ? 'There is nowhere to push to yet. Create a repository in Git first.' : 'Asks before sending anything'}><ArrowUp size={14} /> {overview?.upstream === null ? 'Publish branch' : 'Push'}</UiButton>
        <UiButton type="button" className="composer-text-button" onClick={onClose}>Close</UiButton>
      </div>
      {notice && <p className="studio-notice" role="status"><Check size={14} /> {notice}</p>}
      {error && <p className="studio-notice error" role="alert">{error}</p>}
    </div>
  );
}
