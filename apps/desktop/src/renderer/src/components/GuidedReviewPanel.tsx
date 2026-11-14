import { BookOpen, CheckCircle2, ChevronRight, ClipboardCopy, FileCode2, GitCompare, MessageSquareText, ShieldAlert, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MAX_REVIEW_FILES, type ChangeReviewResult, type GitChange, type ReviewFinding } from '@kai/contracts';
import { unwrap } from '../types';
import { reviewToMarkdown } from '../review-markdown';
import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { Checkbox, Textarea } from 'flowbite-react';

type ReviewMode = 'novice' | 'intermediate' | 'expert';
type ReviewScope = 'changes' | 'active-file' | 'selection';
type ReviewStatus = 'unreviewed' | 'reviewed' | 'understood' | 'question' | 'needs-change' | 'approved';

interface ReviewNote { path: string; status: ReviewStatus; note: string; updatedAt: string }

function storageKey(projectId: string): string { return `kai.guidedReview.${projectId}`; }

function readNotes(projectId: string): Record<string, ReviewNote> {
  try { return JSON.parse(window.localStorage.getItem(storageKey(projectId)) ?? '{}') as Record<string, ReviewNote>; } catch { return {}; }
}

function writeNotes(projectId: string, notes: Record<string, ReviewNote>): void {
  try { window.localStorage.setItem(storageKey(projectId), JSON.stringify(notes)); } catch { /* Review remains available without persistence. */ }
}

export function GuidedReviewPanel({
  projectId,
  changes,
  activePath,
  hasSelection,
  onOpenFile,
  onExplainFile,
  onCreateFollowup,
  onOpenAt,
  onOpenSettings,
}: {
  projectId: string;
  changes: readonly GitChange[];
  activePath: string | null;
  hasSelection: boolean;
  onOpenFile: (path: string) => Promise<void>;
  onExplainFile: (path: string) => Promise<void>;
  onCreateFollowup: (prompt: string) => void;
  /** Opens a file at a line, for a finding that points to one. Without it a finding just opens its file. */
  onOpenAt?: (path: string, line: number) => void;
  /** Where to send someone whose AI review has no model to run on. */
  onOpenSettings?: () => void;
}): ReactNode {
  const [mode, setMode] = useState<ReviewMode>(() => (window.localStorage.getItem('kai.reviewMode') as ReviewMode) || 'novice');
  const [scope, setScope] = useState<ReviewScope>('changes');
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [notes, setNotes] = useState<Record<string, ReviewNote>>(() => readNotes(projectId));
  const [noteText, setNoteText] = useState('');
  const [aiResult, setAiResult] = useState<ChangeReviewResult | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [hideDone, setHideDone] = useState(() => { try { return window.localStorage.getItem('kai.reviewHideDone') === '1'; } catch { return false; } });

  useEffect(() => { setNotes(readNotes(projectId)); setPath(null); setDiff(''); setAiResult(null); setAiError(null); }, [projectId]);
  useEffect(() => { try { window.localStorage.setItem('kai.reviewMode', mode); } catch { /* preference only */ } }, [mode]);
  useEffect(() => { try { window.localStorage.setItem('kai.reviewHideDone', hideDone ? '1' : '0'); } catch { /* preference only */ } }, [hideDone]);

  const scopedPaths = useMemo(() => {
    if (scope === 'active-file') return activePath ? [activePath] : [];
    if (scope === 'selection') return activePath && hasSelection ? [activePath] : [];
    return changes.map((change) => change.path);
  }, [activePath, changes, hasSelection, scope]);
  const selectedPath = path && scopedPaths.includes(path) ? path : scopedPaths[0] ?? null;
  const reviewed = scopedPaths.filter((item) => notes[item]?.status && notes[item].status !== 'unreviewed').length;
  const currentNote = selectedPath ? notes[selectedPath] : undefined;
  const isDone = (item: string): boolean => { const status = notes[item]?.status; return Boolean(status && status !== 'unreviewed'); };
  // The file being read stays in the list even when finished files are hidden, so marking it does not make it vanish.
  const visiblePaths = hideDone ? scopedPaths.filter((item) => !isDone(item) || item === selectedPath) : scopedPaths;
  const visibleIndex = selectedPath ? visiblePaths.indexOf(selectedPath) : -1;
  const percentDone = scopedPaths.length ? Math.round((reviewed / scopedPaths.length) * 100) : 0;

  useEffect(() => {
    if (!selectedPath) { setDiff(''); return; }
    let cancelled = false;
    setLoadingDiff(true);
    void window.kaiDesktop.gitDiff(projectId, selectedPath, false).then(unwrap).then(async (result) => {
      const text = result.output || (await window.kaiDesktop.gitDiff(projectId, selectedPath, true).then(unwrap)).output;
      if (!cancelled) setDiff(text || 'There is no text diff for this file (it may be binary or unchanged).');
    }).catch((error) => { if (!cancelled) setDiff(error instanceof Error ? error.message : 'Could not load this diff.'); })
      .finally(() => { if (!cancelled) setLoadingDiff(false); });
    return () => { cancelled = true; };
  }, [projectId, selectedPath]);

  const update = (status: ReviewStatus, note = noteText): void => {
    if (!selectedPath) return;
    const next = { ...notes, [selectedPath]: { path: selectedPath, status, note: note.trim(), updatedAt: new Date().toISOString() } };
    setNotes(next); writeNotes(projectId, next); setNoteText(note.trim());
  };
  const copyReport = (): void => {
    const report = [`Guided review · ${mode}`, `Scope: ${scope}`, `Reviewed: ${reviewed}/${scopedPaths.length}`, ...scopedPaths.map((item) => {
      const note = notes[item]; return `- ${item}: ${note?.status ?? 'unreviewed'}${note?.note ? ` — ${note.note}` : ''}`;
    })].join('\n');
    void navigator.clipboard.writeText(report);
  };
  const guidance = mode === 'novice'
    ? 'Start with intent and flow. Open each changed file to see what role it plays before reading the diff.'
    : mode === 'intermediate'
      ? 'Review responsibilities, dependencies, error paths, and the tests that would prove this change.'
      : 'Focus on architecture impact, contracts, failure modes, security boundaries, and regression risk.';
  const select = (item: string): void => { setPath(item); setNoteText(''); if (!isDeleted(item)) void onOpenFile(item); };
  const step = (delta: number): void => {
    const next = visiblePaths[visibleIndex + delta];
    if (next) select(next);
  };
  /** The next file still to review after this one, going round to the start, or null when this is the last. */
  const nextUnreviewed = (from: string): string | null => {
    const start = scopedPaths.indexOf(from);
    for (let offset = 1; offset < scopedPaths.length; offset += 1) {
      const candidate = scopedPaths[(start + offset) % scopedPaths.length]!;
      if (!isDone(candidate)) return candidate;
    }
    return null;
  };
  const markReviewedAndNext = (): void => {
    if (!selectedPath) return;
    const upcoming = nextUnreviewed(selectedPath);
    update('reviewed', currentNote?.note ?? noteText);
    if (upcoming) select(upcoming);
  };
  const runAiReview = async (): Promise<void> => {
    if (scopedPaths.length === 0) return;
    setReviewing(true); setAiResult(null); setAiError(null);
    try {
      setAiResult(unwrap(await window.kaiDesktop.reviewChanges({ projectId, paths: scopedPaths.slice(0, MAX_REVIEW_FILES), mode })));
    } catch (error) { setAiError(error instanceof Error ? error.message : 'The AI review could not be completed.'); }
    finally { setReviewing(false); }
  };
  const findingsByFile = useMemo(() => {
    const map = new Map<string, ReviewFinding[]>();
    for (const finding of aiResult?.findings ?? []) map.set(finding.file, [...(map.get(finding.file) ?? []), finding]);
    return map;
  }, [aiResult]);
  const statusOf = (item: string): GitChange | undefined => changes.find((change) => change.path === item);
  const isDeleted = (item: string): boolean => { const change = statusOf(item); return change?.worktree === 'D' || change?.index === 'D'; };
  const openFinding = (finding: ReviewFinding): void => {
    setPath(finding.file);
    if (finding.line && onOpenAt && !isDeleted(finding.file)) onOpenAt(finding.file, finding.line);
    else if (!isDeleted(finding.file)) void onOpenFile(finding.file);
  };
  const fixPrompt = (finding: ReviewFinding): string => `Fix this review finding in ${finding.file}${finding.line ? ` (around line ${finding.line})` : ''}: ${finding.note}`;
  const reviewLabel = reviewing
    ? `Reviewing ${Math.min(scopedPaths.length, MAX_REVIEW_FILES)} ${scopedPaths.length === 1 ? 'file' : 'files'}…`
    : aiResult ? 'Review again' : `AI review ${scopedPaths.length} ${scopedPaths.length === 1 ? 'change' : 'changes'}`;

  return <aside className="guided-review-panel" aria-label="Guided code review">
    <header className="guided-review-head"><div><strong>Guided Review</strong><small>{reviewed}/{scopedPaths.length} files reviewed</small></div><UiButton type="button" className="icon-button compact" title="Copy review report" aria-label="Copy review report" onClick={copyReport}><ClipboardCopy size={13} /></UiButton></header>
    <div className="guided-review-progress" role="progressbar" aria-label="Files reviewed" aria-valuemin={0} aria-valuemax={scopedPaths.length} aria-valuenow={reviewed}><span style={{ width: `${percentDone}%` }} /></div>
    <div className="guided-review-controls">
      <label className="field"><span>Mode</span><Select value={mode} onChange={(event) => setMode(event.target.value as ReviewMode)}><option value="novice">Novice</option><option value="intermediate">Intermediate</option><option value="expert">Expert</option></Select></label>
      <label className="field"><span>Scope</span><Select value={scope} onChange={(event) => setScope(event.target.value as ReviewScope)}><option value="changes">Uncommitted changes</option><option value="active-file">Active file</option><option value="selection" disabled={!hasSelection}>Selected code</option></Select></label>
    </div>
    <p className="guided-review-guidance"><Sparkles size={13} />{guidance}</p>
    {scopedPaths.length > 1 && <label className="guided-review-toggle"><Checkbox checked={hideDone} onChange={(event) => setHideDone(event.target.checked)} /><span>Hide files I have reviewed</span></label>}
    {!scopedPaths.length ? <div className="guided-review-empty"><GitCompare size={16} /><strong>Nothing selected for review</strong><span>{scope === 'changes' ? 'Make or refresh Git changes, or choose Active file.' : 'Open a file and select code to review it here.'}</span></div> : <>
      <section className="guided-review-ai" aria-label="AI review">
        <div className="guided-review-actions">
          <UiButton type="button" className="primary-button" disabled={reviewing} onClick={() => void runAiReview()}><Sparkles size={13} />{reviewLabel}</UiButton>
        </div>
        {scopedPaths.length > MAX_REVIEW_FILES && <p className="guided-review-hint">Reviews the first {MAX_REVIEW_FILES} of {scopedPaths.length} files; review the rest in another pass.</p>}
        {!aiResult && !aiError && !reviewing && <p className="guided-review-hint">A second model reads every changed file together and lists what needs attention, with a button to open each file.</p>}
        {reviewing && <p className="guided-review-hint" role="status">Reading the changes. This usually takes under a minute.</p>}
        {aiError && <div className="guided-review-ai-error" role="alert">
          <strong>The AI review could not run</strong>
          <p>{aiError}</p>
          {onOpenSettings && <UiButton type="button" className="secondary-button" onClick={onOpenSettings}>Open Settings</UiButton>}
        </div>}
        {aiResult && <AiReviewResult
          result={aiResult}
          isDeleted={isDeleted}
          onOpen={openFinding}
          onFix={(finding) => onCreateFollowup(fixPrompt(finding))}
          onFixAll={() => onCreateFollowup(`Work through these review findings:\n${aiResult.findings.map((finding, index) => `${index + 1}. ${fixPrompt(finding)}`).join('\n')}`)}
        />}
      </section>
      {visiblePaths.length === 0 ? <div className="guided-review-empty"><CheckCircle2 size={16} /><strong>All {scopedPaths.length} files reviewed</strong><UiButton type="button" className="secondary-button" onClick={() => setHideDone(false)}>Show them again</UiButton></div> : <div className="guided-review-files">{visiblePaths.map((item) => {
        const count = findingsByFile.get(item)?.length ?? 0;
        const done = isDone(item);
        return <UiButton key={item} type="button" className={`${item === selectedPath ? 'active' : ''}${done ? ' done' : ''}`.trim()} onClick={() => select(item)}>
          {done ? <CheckCircle2 size={13} className="guided-review-done" aria-label="Reviewed" /> : <FileCode2 size={13} />}<span>{item}</span>
          {count > 0 ? <small className="guided-review-count">{count} {count === 1 ? 'finding' : 'findings'}</small> : <small>{isDeleted(item) ? 'deleted' : STATUS_LABEL[notes[item]?.status ?? 'unreviewed']}</small>}
          <ChevronRight size={13} />
        </UiButton>;
      })}</div>}
      {selectedPath && <section className="guided-review-detail">
        <div className="guided-review-nav">
          <UiButton type="button" className="secondary-button" disabled={visibleIndex <= 0} onClick={() => step(-1)} aria-label="Previous file">‹ Previous</UiButton>
          <span>{visibleIndex + 1} of {visiblePaths.length}</span>
          <UiButton type="button" className="secondary-button" disabled={visibleIndex < 0 || visibleIndex >= visiblePaths.length - 1} onClick={() => step(1)} aria-label="Next file">Next ›</UiButton>
        </div>
        <div className="guided-review-file-title"><FileCode2 size={14} /><strong>{selectedPath}</strong></div>
        <ReviewExplanation mode={mode} path={selectedPath} diff={diff} deleted={isDeleted(selectedPath)} added={(() => { const change = statusOf(selectedPath); return change?.worktree === '?' || change?.index === 'A'; })()} />
        {(findingsByFile.get(selectedPath) ?? []).length > 0 && <div className="guided-review-file-findings">
          <strong>AI review found</strong>
          <ul>{(findingsByFile.get(selectedPath) ?? []).map((finding, index) => <li key={index}><span className={`review-chip ${finding.severity}`}>{finding.severity}</span>{finding.line ? <em>line {finding.line}</em> : null}<p>{finding.note}</p></li>)}</ul>
        </div>}
        <div className="guided-review-actions"><UiButton type="button" className="secondary-button" disabled={isDeleted(selectedPath)} title={isDeleted(selectedPath) ? 'This file was deleted, so there is nothing to explain or open.' : undefined} onClick={() => void onExplainFile(selectedPath)}><BookOpen size={13} />Explain with KAI</UiButton><UiButton type="button" className="secondary-button" onClick={() => onCreateFollowup(`Review follow-up for ${selectedPath}: ${currentNote?.note || 'Investigate this change, address any risks, and explain the result.'}`)}><MessageSquareText size={13} />Create follow-up</UiButton><UiButton type="button" className="secondary-button" disabled={isDeleted(selectedPath)} title={isDeleted(selectedPath) ? 'This file was deleted.' : undefined} onClick={() => void onOpenFile(selectedPath)}>Open code</UiButton></div>
        <details className="guided-review-diff"><summary>{loadingDiff ? 'Loading diff…' : 'View diff'}</summary><pre>{diff || 'No diff loaded.'}</pre></details>
        <label className="guided-review-note">Review note<Textarea value={noteText || currentNote?.note || ''} onChange={(event) => setNoteText(event.target.value)} placeholder="Decision, question, risk, or test to run" /></label>
        <div className="guided-review-actions"><UiButton type="button" className="primary-button" onClick={markReviewedAndNext}><CheckCircle2 size={13} />{nextUnreviewed(selectedPath) ? 'Mark reviewed and go to next' : 'Mark reviewed'}</UiButton></div>
        <div className="guided-review-statuses"><UiButton type="button" className={`secondary-button${currentNote?.status === 'understood' ? ' active-button' : ''}`} onClick={() => update('understood')}>Understood</UiButton><UiButton type="button" className={`secondary-button${currentNote?.status === 'question' ? ' active-button' : ''}`} onClick={() => update('question')}>Question</UiButton><UiButton type="button" className={`secondary-button${currentNote?.status === 'needs-change' ? ' active-button' : ''}`} onClick={() => update('needs-change')}><ShieldAlert size={12} />Needs change</UiButton><UiButton type="button" className={`secondary-button${currentNote?.status === 'approved' ? ' active-button' : ''}`} onClick={() => update('approved')}><CheckCircle2 size={12} />Approve</UiButton></div>
      </section>}
    </>}
  </aside>;
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  unreviewed: 'unreviewed',
  reviewed: 'reviewed',
  understood: 'understood',
  question: 'question',
  'needs-change': 'needs change',
  approved: 'approved',
};

const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** What the AI review found: a verdict, its findings with buttons to open each file, and what it did not read. */
function AiReviewResult({ result, isDeleted, onOpen, onFix, onFixAll }: {
  result: ChangeReviewResult;
  isDeleted: (path: string) => boolean;
  onOpen: (finding: ReviewFinding) => void;
  onFix: (finding: ReviewFinding) => void;
  onFixAll: () => void;
}): ReactNode {
  const verdict = result.findings.length === 0 ? 'No problems found' : result.ok ? 'Minor notes only' : 'Needs your attention';
  const tone = result.findings.length === 0 ? 'ok' : result.ok ? 'minor' : 'attention';
  return <div className="guided-review-ai-card" aria-live="polite">
    <div className="guided-review-verdict"><span className={`review-verdict ${tone}`}>{verdict}</span><small>Read {result.reviewedFiles.length} {result.reviewedFiles.length === 1 ? 'file' : 'files'}</small></div>
    {result.summary && <p className="guided-review-summary">{result.summary}</p>}
    {result.dismissed ? <p className="guided-review-summary">A second check dismissed {result.dismissed} {result.dismissed === 1 ? 'finding' : 'findings'} the diff did not support.</p> : null}
    {result.findings.length > 0 && <>
      <ul className="review-findings">{result.findings.map((finding, index) => <li key={index} className={`review-finding ${finding.severity}`}>
        <div className="review-finding-head"><span className={`review-chip ${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span><span className="review-finding-file" title={finding.file}>{finding.file}{finding.line ? `:${finding.line}` : ''}</span>{finding.verdict === 'plausible' && <span className="review-chip low" title="A second check could not confirm this from the diff alone.">Unconfirmed</span>}</div>
        <p>{finding.note}</p>
        <div className="review-finding-actions">
          <UiButton type="button" className="secondary-button" disabled={isDeleted(finding.file)} title={isDeleted(finding.file) ? 'This file was deleted.' : undefined} onClick={() => onOpen(finding)}>{finding.line ? 'Open at line' : 'Open file'}</UiButton>
          <UiButton type="button" className="secondary-button" onClick={() => onFix(finding)}>Fix with KAI</UiButton>
        </div>
      </li>)}</ul>
      <div className="guided-review-actions">
        {result.findings.length > 1 && <UiButton type="button" className="secondary-button" onClick={onFixAll}>Send all {result.findings.length} to KAI</UiButton>}
        <UiButton type="button" className="secondary-button" title="Copies this review as Markdown for a pull request. KAI does not post it anywhere." onClick={() => { void navigator.clipboard.writeText(reviewToMarkdown(result)).catch(() => undefined); }}><ClipboardCopy size={13} /><span>Copy as Markdown</span></UiButton>
      </div>
    </>}
    {result.skippedFiles.length > 0 && <details className="guided-review-skipped"><summary>{result.skippedFiles.length} not read</summary><ul>{result.skippedFiles.map((skipped) => <li key={skipped.file}><span>{skipped.file}</span><small>{skipped.reason}</small></li>)}</ul></details>}
  </div>;
}

function ReviewExplanation({ mode, path, diff, deleted, added }: { mode: ReviewMode; path: string; diff: string; deleted: boolean; added: boolean }): ReactNode {
  const additions = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
  const removals = (diff.match(/^-(?!--)/gm) ?? []).length;
  const role = /(?:api|service|client|server|route)/i.test(path) ? 'a connection or service boundary' : /(?:test|spec)/i.test(path) ? 'automated verification' : /(?:style|css|theme)/i.test(path) ? 'the visual interface' : 'the application implementation';
  const copy = deleted
    ? `This file was deleted. Check that nothing still imports or links to it, and that whatever it did now lives somewhere else.`
    : added
      ? `This file is new. Read what it exports first, then check that the places using it are wired up and covered by a test.`
      : mode === 'novice'
        ? `This file is part of ${role}. Read the KAI explanation first, then use the diff to connect the before and after.`
        : mode === 'intermediate'
          ? `Check what imports this file, what it calls, and whether the ${additions} additions and ${removals} removals preserve its existing contract.`
          : `Inspect contract changes, side effects, error paths, ownership boundaries, and test coverage for this ${role} change.`;
  return <div className="guided-review-explanation"><p><strong>What to review</strong>{copy}</p><p><strong>Diff signal</strong>{additions} additions · {removals} removals</p><p><strong>How to test</strong>Open the affected flow, exercise success and failure paths, then run the nearest relevant check.</p></div>;
}
