import { ArrowDown, ArrowUp, Copy, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, Minus, Plus, RefreshCw, TerminalSquare } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { GitChange, GitGithubState, GitOverview, GitRepositoryVisibility, GitSyncAction, ProjectRecord } from '@kai/contracts';
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

/**
 * A repository name GitHub will accept, taken from the project's own name so the field arrives filled in. GitHub's
 * rules are narrower than a folder name's: lowercase letters, digits, dots, dashes and underscores only.
 */
function repositoryNameFrom(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/[.-]+$/, '')
    .slice(0, 100);
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
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [pr, setPr] = useState({ title: '', body: '' });
  // Creating the remote: the name to register on GitHub, who may see it, and what `gh` last said about the account.
  const [repoName, setRepoName] = useState('');
  const [repoVisibility, setRepoVisibility] = useState<GitRepositoryVisibility>('private');
  const [githubState, setGithubState] = useState<GitGithubState | null>(null);

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
    setRepoName(repositoryNameFrom(activeProject?.name ?? ''));
    setSelectedPaths(new Set());
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, activeProject?.name]);

  /**
   * Whether `gh` is installed and signed in. The overview only reports that for a project that already publishes to
   * GitHub, so a project with nowhere to push asks separately — the create flow needs the answer before it can offer
   * anything. Re-asked on each poll so signing in elsewhere shows up here without a reload.
   */
  useEffect(() => {
    if (!projectId || !overview?.isRepository || overview.githubRepository) {
      setGithubState(null);
      return;
    }
    let cancelled = false;
    void window.kaiDesktop.gitGithubStatus(projectId).then((response) => {
      if (!cancelled && response.ok) setGithubState(response.data);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, overview]);

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

  /**
   * Starts a repository in the project folder. `git init` does nothing when one is already there, so the button is
   * safe to press twice; `act` refreshes the page afterwards, which is what turns the empty state into the Git view.
   */
  function startRepository(): Promise<void> {
    if (!activeProject) return Promise.resolve();
    return act('Starting a repository', async () => {
      unwrap(await window.kaiDesktop.gitInit(activeProject.id));
    }, 'Repository started.');
  }

  /**
   * Creates the repository on GitHub and points `origin` at it, after the person confirms the name and who will be
   * able to see it. Nothing is uploaded: `gh` is asked not to push, so sending code stays the separate, confirmed
   * Publish branch step.
   */
  async function createRepository(): Promise<void> {
    if (!activeProject) return;
    const name = repoName.trim();
    const visibility = repoVisibility;
    const confirmed = await confirmDialog({
      title: `Create ${name} on GitHub?`,
      detail: visibility === 'private'
        ? `This creates the private repository "${name}" on your GitHub account and sets it as this project's origin. Only you and the people you invite will be able to see it.\n\nYour code is not uploaded yet — press Publish branch when you are ready for that.`
        : `This creates the public repository "${name}" on your GitHub account. Anyone on the internet will be able to see it and clone it.\n\nIt is set as this project's origin. Your code is not uploaded yet — press Publish branch when you are ready for that.`,
      confirmLabel: 'Create repository',
    });
    if (!confirmed) return;
    await act('Create repository', async () => {
      const result = unwrap(await window.kaiDesktop.gitCreateRepository(activeProject.id, name, visibility));
      return `Created ${result.repository} on GitHub and set it as origin. Publish the branch when you are ready to upload your commits.`;
    });
  }

  // Signing in is needed in both places the GitHub section appears: a project with no remote yet, and one whose
  // remote exists but has no signed-in account behind it.
  const signInActions = (
    <div className="ops-actions">
      <button type="button" className="primary-button" onClick={onSignInGitHub ?? onOpenTerminal}><TerminalSquare size={14} /><span>Sign in with GitHub</span></button>
      <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText('gh auth login').then(() => setMessage('Copied “gh auth login”. Paste it into the KAI Terminal, then follow GitHub’s browser approval.')).catch(() => setError('Could not copy the command. Run gh auth login in the KAI Terminal.'))}><Copy size={14} /><span>Copy sign-in command</span></button>
    </div>
  );

  if (!activeProject) {
    return <div className="page-view"><header className="page-header"><div><h1>Git</h1><p>Open a project to see its branches and changes</p></div></header><div className="empty-list">No project is open</div></div>;
  }
  if (!overview) return <div className="page-view"><header className="page-header"><div><h1>Git</h1></div></header>{error ? <div className="workbench-error" role="alert">{error}</div> : <div className="empty-list">Loading…</div>}</div>;
  if (!overview.isRepository) {
    return (
      <div className="page-view">
        <header className="page-header"><div><h1>Git</h1><p>{activeProject.name}</p></div></header>
        <div className="empty-list">
          <p>This project is not a Git repository yet. Starting one is a single command, and KAI can run it for you.</p>
          <div className="git-starter">
            <code>git init</code>
            <button type="button" className="primary-button" onClick={() => void startRepository()} disabled={busy !== null} title="Runs git init in this project's folder and names the first branch main">
              {busy ? <Loader2 className="spin" size={14} /> : <GitBranch size={14} />} Start a repository
            </button>
            {onOpenTerminal && (
              <button type="button" className="secondary-button" onClick={onOpenTerminal} disabled={busy !== null} title="Open the Terminal to run the commands yourself">
                <TerminalSquare size={14} /> Open the Terminal
              </button>
            )}
          </div>
          <p className="studio-note">
            What comes next: <code>git add -A</code> to stage everything, <code>git commit -m &quot;first commit&quot;</code> to record it,
            then somewhere to push to. Once there is a first commit, this page's GitHub section creates that repository
            for you — private or public — so you never have to type <code>git remote add origin &lt;url&gt;</code> yourself.
          </p>
          {error && <div className="workbench-error" role="alert">{error}</div>}
          {message && <div className="workbench-notice" role="status">{message}</div>}
        </div>
      </div>
    );
  }

  const staged = overview.changes.filter((change) => change.staged);
  const onMain = overview.branch === 'main' || overview.branch === 'master';
  const sync = (action: GitSyncAction, label: string): Promise<void> => act(label, async () => unwrap(await window.kaiDesktop.gitSync(activeProject.id, action)).output);
  const createCommand = `gh repo create ${repoName.trim() || 'my-project'} --${repoVisibility} --source . --remote origin`;

  /**
   * What the GitHub section shows when the project does not publish to GitHub yet. The pointed part is the create
   * step: a person who has never made a repository should leave this page with one, not with a command to go and run.
   */
  const githubPanel = overview.remotes.length > 0 ? (
    // A project that already pushes somewhere else keeps that remote: `origin` is taken, and repointing it would
    // quietly send the next push somewhere new.
    <p className="settings-note">
      This project's remote ({overview.remotes.map((remote) => remote.name).join(', ')}) is not on GitHub, so pull requests
      cannot be offered here. Pushing still works with any Git remote.
    </p>
  ) : (
    <>
      <p className="settings-note">
        This project has no remote yet, so its work lives only on this machine. KAI can create the repository on GitHub
        and point <code>origin</code> at it.
      </p>
      {!githubState ? <p className="settings-note">Checking for the GitHub CLI…</p> : !githubState.cliAvailable ? (
        <>
          <p className="settings-note">
            The GitHub CLI (<code>gh</code>) is not installed, so KAI cannot create the repository for you. Install it
            from cli.github.com and reopen this page, or set up any other Git host yourself with{' '}
            <code>git remote add origin &lt;url&gt;</code> in the Terminal. Pushing works with any Git remote.
          </p>
          <div className="ops-actions">
            <button type="button" className="secondary-button" onClick={() => window.open('https://cli.github.com')}><ExternalLink size={14} /><span>Open the install page</span></button>
            {onOpenTerminal && <button type="button" className="secondary-button" onClick={onOpenTerminal}><TerminalSquare size={14} /><span>Open the Terminal</span></button>}
          </div>
        </>
      ) : !githubState.signedInAs ? (
        <>
          <p className="settings-note">GitHub CLI is installed but not signed in. Sign in once, and KAI can create the repository here.</p>
          {signInActions}
        </>
      ) : (
        <>
          <div className="field-grid">
            <label className="field"><span>Repository name</span><input value={repoName} placeholder="my-project" onChange={(event) => setRepoName(event.target.value)} /></label>
            <label className="field">
              <span>Who can see it</span>
              <Select value={repoVisibility} onChange={(event) => setRepoVisibility(event.target.value === 'public' ? 'public' : 'private')}>
                <option value="private">Private — only you and the people you invite</option>
                <option value="public">Public — anyone can see and clone it</option>
              </Select>
            </label>
          </div>
          <p className="settings-note">
            KAI runs <code>{createCommand}</code> in this project's folder. That registers the repository on GitHub under{' '}
            {githubState.signedInAs} and sets it as <code>origin</code>. Nothing is uploaded: press{' '}
            <strong>Publish branch</strong> when you are ready to send your commits.
          </p>
          <div className="ops-actions">
            <button type="button" className="primary-button" disabled={busy !== null || !repoName.trim()} title="Creates the repository on GitHub and sets it as origin. Your code stays here until you publish." onClick={() => void createRepository()}>
              {busy === 'Create repository' ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} Create repository on GitHub
            </button>
            <button type="button" className="secondary-button" disabled={busy !== null} title="The same command, for running in a Terminal yourself" onClick={() => void navigator.clipboard?.writeText(createCommand).then(() => setMessage('Copied the create command. Paste it into the KAI Terminal to run it yourself.')).catch(() => setError('Could not copy the command.'))}><Copy size={14} /><span>Copy command</span></button>
            {onOpenTerminal && <button type="button" className="secondary-button" onClick={onOpenTerminal} disabled={busy !== null}><TerminalSquare size={14} /><span>Open the Terminal</span></button>}
          </div>
        </>
      )}
    </>
  );

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
          <button type="button" className="secondary-button" disabled={busy !== null} title="Ask the remote what has changed. Changes nothing on your machine." onClick={() => void sync('fetch', 'Fetch')}><RefreshCw size={14} /><span>Fetch</span></button>
          <button type="button" className="secondary-button" disabled={busy !== null || !overview.upstream} title="Fast-forward only; never merges or rewrites history" onClick={() => void sync('pull', 'Pull')}><ArrowDown size={14} /><span>Pull</span></button>
          <button type="button" className="primary-button" disabled={busy !== null || !overview.branch || overview.remotes.length === 0 || (overview.upstream !== null && overview.ahead === 0)} title={overview.remotes.length === 0 ? 'There is nowhere to push to yet — create a repository on GitHub in the GitHub section below' : undefined} onClick={() => void (async () => {
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

      {/* Git's words mean nothing to someone who has not used it, so the workflow is spelled out in order before the
          controls that carry it out. Each step is one of the buttons on this page. */}
      <details className="git-explainer">
        <summary>New to Git? What these buttons do</summary>
        <ol>
          <li><strong>Stage</strong> — choose which changed files go into the next save. Nothing else is affected.</li>
          <li><strong>Commit</strong> — save those files as one labelled point in the project's history, on your machine.</li>
          <li><strong>Create repository on GitHub</strong> — make the remote that the next two steps send to. You choose whether it is private or public; nothing is uploaded yet.</li>
          <li><strong>Publish branch</strong> — the first send of a branch to the remote, so it exists somewhere other than here.</li>
          <li><strong>Push</strong> — send later commits to that remote. KAI never force-pushes, so it cannot overwrite somebody else's work.</li>
          <li><strong>Fetch</strong> — ask the remote what has changed. It changes nothing on your machine; check first, act after.</li>
          <li><strong>Pull</strong> — bring those changes down. Fast-forward only, so it refuses rather than merging behind your back.</li>
        </ol>
        <p className="settings-note">The everyday loop is: stage, commit, push. A branch is a separate line of work you can throw away without touching the main one.</p>
      </details>

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
                {selectedPaths.size > 0 && <button type="button" className="primary-button" disabled={busy !== null} onClick={() => void act('Stage selected', async () => unwrap(await window.kaiDesktop.gitStage(activeProject.id, [...selectedPaths], true)).output, `Staged ${selectedPaths.size} selected file${selectedPaths.size === 1 ? '' : 's'}.`)}>Stage selected ({selectedPaths.size})</button>}
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
                            <input type="checkbox" className="git-change-select" checked={selectedPaths.has(change.path)} aria-label={`Select ${change.path}`} onChange={() => setSelectedPaths((current) => { const next = new Set(current); if (next.has(change.path)) next.delete(change.path); else next.add(change.path); return next; })} />
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
          {!overview.githubRepository ? githubPanel : (
            <>
              <p className="settings-note">
                {overview.githubRepository}
                {overview.github.signedInAs ? ` · signed in as ${overview.github.signedInAs}` : overview.github.cliAvailable ? ' · GitHub CLI is installed but not signed in.' : ' · Install the GitHub CLI (gh) to open pull requests from KAI. Pushing works without it.'}
              </p>
              {!overview.github.signedInAs && overview.github.cliAvailable && signInActions}
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
