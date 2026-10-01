import { ArrowDown, ArrowUp, Copy, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, Minus, Plus, RefreshCw, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { GitChange, GitOverview, GitSyncAction, ProjectRecord } from '@kai/contracts';
import { relativeTime, unwrap } from '../types';
import { confirmDialog } from './AppDialog';
import { GitBadge } from './GitBadge';
import { changeKindOf } from './project-files-tree';

import { Select } from './ui/Select';
const POLL_MS = 10_000;

const STATE_WORDS: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'new', U: 'conflict', '.': '' };

function describeChange(change: GitChange): string {
  const letter = change.index !== '.' && change.index !== '?' ? change.index : change.worktree === '.' ? change.index : change.worktree;
  return STATE_WORDS[letter] ?? letter;
}

export function GitView({ activeProject, onOpenTerminal, onSignInGitHub }: { activeProject: ProjectRecord | null; onOpenTerminal?: () => void; onSignInGitHub?: () => void }): ReactNode {
  const projectId = activeProject?.id ?? null;
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  // The file being staged or unstaged, so its row shows a spinner until Git answers.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pr, setPr] = useState({ title: '', body: '' });

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = unwrap(await window.kaiDesktop.gitOverview(projectId));
      setOverview(next);
      setSelectedBranch((current) => current || next.branch || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Git status could not be loaded.');
    }
  }, [projectId]);

  useEffect(() => {
    setOverview(null);
    setDiff(null);
    setError(null);
    setMessage(null);
    setSelectedBranch('');
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function act(label: string, action: () => Promise<string | void>, done?: string): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      const output = await action();
      setMessage(done ?? (output ? String(output).slice(0, 400) : `${label} finished.`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed.`);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  if (!activeProject) {
    return <div className="page-view"><header className="page-header"><div><h1>Git</h1><p>Open a project to see its branches and changes</p></div></header><div className="empty-list">No project is open</div></div>;
  }
  if (!overview) return <div className="page-view"><header className="page-header"><div><h1>Git</h1></div></header>{error ? <div className="workbench-error" role="alert">{error}</div> : <div className="empty-list">Loading…</div>}</div>;
  if (!overview.isRepository) {
    return <div className="page-view"><header className="page-header"><div><h1>Git</h1><p>{activeProject.name}</p></div></header><div className="empty-list">This project is not a Git repository. Run <code>git init</code> in the Terminal to start one.</div></div>;
  }

  const staged = overview.changes.filter((change) => change.staged);
  const onMain = overview.branch === 'main' || overview.branch === 'master';
  const sync = (action: GitSyncAction, label: string): Promise<void> => act(label, async () => unwrap(await window.kaiDesktop.gitSync(activeProject.id, action)).output);

  return (
    <div className="page-view git-view">
      <header className="page-header">
        <div>
          <h1>Git</h1>
          <p>
            {activeProject.name} · <GitBranch size={12} /> {overview.branch ?? 'detached HEAD'}
            {overview.upstream ? ` → ${overview.upstream}` : ' (not published)'}
            {overview.ahead > 0 && <span className="git-count"><ArrowUp size={11} />{overview.ahead}</span>}
            {overview.behind > 0 && <span className="git-count"><ArrowDown size={11} />{overview.behind}</span>}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void sync('fetch', 'Fetch')}><RefreshCw size={14} /><span>Fetch</span></button>
          <button type="button" className="secondary-button" disabled={busy !== null || !overview.upstream} title="Fast-forward only; never merges or rewrites history" onClick={() => void sync('pull', 'Pull')}><ArrowDown size={14} /><span>Pull</span></button>
          <button type="button" className="primary-button" disabled={busy !== null || !overview.branch || (overview.upstream !== null && overview.ahead === 0)} onClick={() => void (async () => {
            const target = overview.githubRepository ? `origin (${overview.githubRepository})` : 'the remote';
            const confirmed = await confirmDialog({
              title: 'Push this branch?',
              detail: `Push "${overview.branch}" to ${target}?\n\nThis sends ${overview.ahead > 0 ? `${overview.ahead} commit${overview.ahead === 1 ? '' : 's'}` : 'the branch'} off this machine. KAI never force-pushes.`,
              confirmLabel: 'Push branch',
            });
            if (confirmed) await sync('push', 'Push');
          })()}><ArrowUp size={14} /><span>{overview.upstream ? 'Push' : 'Publish branch'}</span></button>
        </div>
      </header>

      {message && <div className="workbench-notice" role="status"><span className="git-message">{message}</span></div>}
      {error && <div className="workbench-error" role="alert"><span className="git-message">{error}</span></div>}

      <div className="settings-grid">
        <section className="settings-section">
          <div className="section-title"><GitBranch size={16} /><span>Branches</span></div>
          <div className="field-with-action">
            <label className="field"><span>Switch to</span><Select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)}>{overview.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}{branch.current ? ' (current)' : ''}</option>)}</Select></label>
            <button type="button" className="secondary-button" disabled={busy !== null || selectedBranch === overview.branch || !selectedBranch} onClick={() => void act('Switch branch', async () => unwrap(await window.kaiDesktop.gitCheckout(activeProject.id, selectedBranch)).output, `Switched to ${selectedBranch}.`)}>Switch</button>
          </div>
          <div className="field-with-action">
            <label className="field"><span>New branch</span><input value={newBranch} placeholder="feature/my-change" onChange={(event) => setNewBranch(event.target.value)} /></label>
            <button type="button" className="secondary-button" disabled={busy !== null || !newBranch.trim()} onClick={() => void act('Create branch', async () => {
              unwrap(await window.kaiDesktop.gitCreateBranch(activeProject.id, newBranch.trim(), true));
              setSelectedBranch(newBranch.trim());
              setNewBranch('');
            }, `Created and switched to ${newBranch.trim()}.`)}>Create and switch</button>
          </div>
          <ul className="git-list">{overview.branches.map((branch) => <li key={branch.name} className={branch.current ? 'current' : ''}><strong>{branch.name}</strong><span className="truncate">{branch.subject}</span><small>{branch.upstream ?? 'local only'}</small></li>)}</ul>
        </section>

        <section className="settings-section">
          <div className="section-title"><GitCommitHorizontal size={16} /><span>Commit</span></div>
          <label className="field"><span>Message</span><textarea rows={3} value={commitMessage} placeholder="Describe what changed and why" onChange={(event) => setCommitMessage(event.target.value)} /></label>
          <button type="button" className="primary-button align-end" disabled={busy !== null || staged.length === 0 || !commitMessage.trim()} onClick={() => void act('Commit', async () => {
            unwrap(await window.kaiDesktop.gitCommit(activeProject.id, commitMessage.trim()));
            setCommitMessage('');
          }, `Committed ${staged.length} file${staged.length === 1 ? '' : 's'}.`)}>Commit {staged.length} staged file{staged.length === 1 ? '' : 's'}</button>
          <p className="settings-note">Repository hooks run as usual. Only staged files are committed.</p>
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><span>Changes ({overview.changes.length})</span></div>
          {overview.changes.length === 0 ? <div className="empty-list">Working tree is clean</div> : (
            <>
              <div className="ops-actions">
                <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void act('Stage all', async () => unwrap(await window.kaiDesktop.gitStage(activeProject.id, overview.changes.map((change) => change.path), true)).output, 'Staged everything.')}>Stage all</button>
                <button type="button" className="secondary-button" disabled={busy !== null || staged.length === 0} onClick={() => void act('Unstage all', async () => unwrap(await window.kaiDesktop.gitStage(activeProject.id, staged.map((change) => change.path), false)).output, 'Unstaged everything.')}>Unstage all</button>
              </div>
              {(['staged', 'unstaged'] as const).map((group) => {
                // A partly staged file is listed in both groups, each showing its own half of the change.
                const rows = overview.changes.filter((change) => group === 'staged' ? change.staged : change.unstaged || !change.staged);
                if (rows.length === 0) return null;
                const staging = group === 'unstaged';
                return (
                  <div key={group} className={`git-change-group ${group}`}>
                    <h3>{staging ? 'Changes' : 'Staged for commit'} <span>{rows.length}</span></h3>
                    <ul className="git-list">
                      {rows.map((change) => {
                        const kind = changeKindOf(change);
                        const shown = { kind, staged: group === 'staged', unstaged: group === 'unstaged' };
                        const pending = busy !== null && pendingPath === change.path;
                        return (
                          <li key={`${group}:${change.path}`} className={`git-${kind}`}>
                            <GitBadge change={shown} />
                            <button type="button" className="git-file" title="Show changes" onClick={() => void window.kaiDesktop.gitDiff(activeProject.id, change.path, group === 'staged').then((response) => setDiff({ path: change.path, text: response.ok ? response.data.output || '(no textual changes)' : response.error.message }))}><span className="truncate">{change.path}</span></button>
                            <small>{describeChange(change)}</small>
                            <button
                              type="button"
                              className="icon-button compact"
                              aria-label={`${staging ? 'Stage' : 'Unstage'} ${change.path}`}
                              title={staging ? 'Stage: include in the next commit' : 'Unstage: leave out of the next commit'}
                              disabled={busy !== null}
                              onClick={() => {
                                setPendingPath(change.path);
                                void act(staging ? 'Stage' : 'Unstage', async () => unwrap(await window.kaiDesktop.gitStage(activeProject.id, [change.path], staging)).output, `${staging ? 'Staged' : 'Unstaged'} ${change.path}.`);
                              }}
                            >
                              {pending ? <Loader2 size={13} className="spin" /> : staging ? <Plus size={13} /> : <Minus size={13} />}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
              {diff && <div className="git-diff"><div className="ops-card-head"><strong>{diff.path}</strong><button type="button" className="secondary-button" onClick={() => setDiff(null)}>Close</button></div><pre>{diff.text}</pre></div>}
            </>
          )}
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><GitPullRequest size={16} /><span>GitHub</span></div>
          {!overview.githubRepository ? <p className="settings-note">This project's remote is not on GitHub{overview.remotes.length === 0 ? ' (no remote is set)' : ''}. Pushing still works with any Git remote.</p> : (
            <>
              <p className="settings-note">
                {overview.githubRepository}
                {overview.github.signedInAs ? ` · signed in as ${overview.github.signedInAs}` : overview.github.cliAvailable ? ' · GitHub CLI is installed but not signed in.' : ' · Install the GitHub CLI (gh) to open pull requests from KAI. Pushing works without it.'}
              </p>
              {!overview.github.signedInAs && overview.github.cliAvailable && (
                <div className="ops-actions">
                  <button type="button" className="primary-button" onClick={onSignInGitHub ?? onOpenTerminal}><TerminalSquare size={14} /><span>Sign in with GitHub</span></button>
                  <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText('gh auth login').then(() => setMessage('Copied “gh auth login”. Paste it into the KAI Terminal, then follow GitHub’s browser approval.')).catch(() => setError('Could not copy the command. Run gh auth login in the KAI Terminal.'))}><Copy size={14} /><span>Copy sign-in command</span></button>
                </div>
              )}
              {overview.pullRequests.map((request) => (
                <div key={request.number} className="ops-card-head"><span>#{request.number} {request.title} · {request.state}</span><button type="button" className="secondary-button" onClick={() => window.open(request.url)}><ExternalLink size={12} /><span>Open</span></button></div>
              ))}
              {overview.github.signedInAs && overview.branch && !onMain && overview.upstream && overview.pullRequests.length === 0 && (
                <>
                  <div className="field-grid">
                    <label className="field"><span>Pull request title</span><input value={pr.title} onChange={(event) => setPr({ ...pr, title: event.target.value })} /></label>
                  </div>
                  <label className="field"><span>Description</span><textarea rows={3} value={pr.body} onChange={(event) => setPr({ ...pr, body: event.target.value })} /></label>
                  <button type="button" className="primary-button align-end" disabled={busy !== null || !pr.title.trim() || overview.ahead > 0} title={overview.ahead > 0 ? 'Push your commits first' : undefined} onClick={() => void (async () => {
                    const confirmed = await confirmDialog({
                      title: 'Open a pull request?',
                      detail: `Open a pull request from "${overview.branch}" on ${overview.githubRepository}? It is visible to everyone with access to the repository.`,
                      confirmLabel: 'Open pull request',
                    });
                    if (!confirmed) return;
                    void act('Open pull request', async () => {
                      const result = unwrap(await window.kaiDesktop.gitPullRequest(activeProject.id, pr.title.trim(), pr.body));
                      setPr({ title: '', body: '' });
                      window.open(result.url);
                    }, 'Pull request opened.');
                  })()}>Open pull request</button>
                </>
              )}
            </>
          )}
        </section>

        <section className="settings-section span-two">
          <div className="section-title"><span>Recent commits</span></div>
          <ul className="git-list">{overview.commits.map((commit) => <li key={commit.hash}><code>{commit.hash}</code><span className="truncate">{commit.subject}</span><small>{commit.author} · {relativeTime(commit.date)}</small></li>)}</ul>
        </section>
      </div>
    </div>
  );
}
