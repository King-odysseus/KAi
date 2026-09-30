import { BookOpen, CheckCircle2, ChevronRight, ClipboardCopy, FileCode2, GitCompare, MessageSquareText, ShieldAlert, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GitChange } from '@kai/contracts';
import { unwrap } from '../types';

type ReviewMode = 'novice' | 'intermediate' | 'expert';
type ReviewScope = 'changes' | 'active-file' | 'selection';
type ReviewStatus = 'unreviewed' | 'understood' | 'question' | 'needs-change' | 'approved';

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
}: {
  projectId: string;
  changes: readonly GitChange[];
  activePath: string | null;
  hasSelection: boolean;
  onOpenFile: (path: string) => Promise<void>;
  onExplainFile: (path: string) => Promise<void>;
  onCreateFollowup: (prompt: string) => void;
}): ReactNode {
  const [mode, setMode] = useState<ReviewMode>(() => (window.localStorage.getItem('kai.reviewMode') as ReviewMode) || 'novice');
  const [scope, setScope] = useState<ReviewScope>('changes');
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [notes, setNotes] = useState<Record<string, ReviewNote>>(() => readNotes(projectId));
  const [noteText, setNoteText] = useState('');
  const [aiReview, setAiReview] = useState('');
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => { setNotes(readNotes(projectId)); setPath(null); setDiff(''); }, [projectId]);
  useEffect(() => { try { window.localStorage.setItem('kai.reviewMode', mode); } catch { /* preference only */ } }, [mode]);

  const scopedPaths = useMemo(() => {
    if (scope === 'active-file') return activePath ? [activePath] : [];
    if (scope === 'selection') return activePath && hasSelection ? [activePath] : [];
    return changes.map((change) => change.path);
  }, [activePath, changes, hasSelection, scope]);
  const selectedPath = path && scopedPaths.includes(path) ? path : scopedPaths[0] ?? null;
  const reviewed = scopedPaths.filter((item) => notes[item]?.status && notes[item].status !== 'unreviewed').length;
  const currentNote = selectedPath ? notes[selectedPath] : undefined;

  useEffect(() => {
    if (!selectedPath) { setDiff(''); return; }
    let cancelled = false;
    setLoadingDiff(true);
    void window.kaiDesktop.gitDiff(projectId, selectedPath, false).then(unwrap).then((result) => {
      if (!cancelled) setDiff(result.output || 'No unstaged text diff is available for this file.');
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
  const runAiReview = async (): Promise<void> => {
    if (!diff.trim()) return;
    setReviewing(true); setAiReview('');
    try {
      const result = unwrap(await window.kaiDesktop.reviewChange(
        `Review the changes in ${selectedPath ?? 'this file'} for correctness, regressions, security, and internal consistency. Explain real findings at the selected ${mode} learning level.`,
        diff,
        mode,
      ));
      setAiReview(result ?? 'No textual diff is available to review.');
    } catch (error) { setAiReview(error instanceof Error ? error.message : 'AI review could not be completed.'); }
    finally { setReviewing(false); }
  };

  return <aside className="guided-review-panel" aria-label="Guided code review">
    <header className="guided-review-head"><div><strong>Guided Review</strong><small>{reviewed}/{scopedPaths.length} files reviewed</small></div><button type="button" className="icon-button compact" title="Copy review report" aria-label="Copy review report" onClick={copyReport}><ClipboardCopy size={13} /></button></header>
    <div className="guided-review-controls">
      <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as ReviewMode)}><option value="novice">Novice</option><option value="intermediate">Intermediate</option><option value="expert">Expert</option></select></label>
      <label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as ReviewScope)}><option value="changes">Uncommitted changes</option><option value="active-file">Active file</option><option value="selection" disabled={!hasSelection}>Selected code</option></select></label>
    </div>
    <p className="guided-review-guidance"><Sparkles size={13} />{guidance}</p>
    {!scopedPaths.length ? <div className="guided-review-empty"><GitCompare size={16} /><strong>Nothing selected for review</strong><span>{scope === 'changes' ? 'Make or refresh Git changes, or choose Active file.' : 'Open a file and select code to review it here.'}</span></div> : <>
      <div className="guided-review-files">{scopedPaths.map((item) => <button key={item} type="button" className={item === selectedPath ? 'active' : ''} onClick={() => { setPath(item); void onOpenFile(item); }}><FileCode2 size={13} /><span>{item}</span><small>{notes[item]?.status ?? 'unreviewed'}</small><ChevronRight size={13} /></button>)}</div>
      {selectedPath && <section className="guided-review-detail"><div className="guided-review-file-title"><FileCode2 size={14} /><strong>{selectedPath}</strong></div>
        <ReviewExplanation mode={mode} path={selectedPath} diff={diff} />
        <div className="guided-review-actions"><button type="button" className="primary-button" disabled={reviewing || loadingDiff || !diff.trim()} onClick={() => void runAiReview()}><Sparkles size={13} />{reviewing ? 'Reviewing…' : 'AI review this diff'}</button></div>
        {aiReview && <pre className="guided-review-ai-result">{aiReview}</pre>}
        <div className="guided-review-actions"><button type="button" className="secondary-button" onClick={() => void onExplainFile(selectedPath)}><BookOpen size={13} />Explain with KAI</button><button type="button" className="secondary-button" onClick={() => onCreateFollowup(`Review follow-up for ${selectedPath}: ${currentNote?.note || 'Investigate this change, address any risks, and explain the result.'}`)}><MessageSquareText size={13} />Create follow-up</button><button type="button" className="secondary-button" onClick={() => void onOpenFile(selectedPath)}>Open code</button></div>
        <details className="guided-review-diff"><summary>{loadingDiff ? 'Loading diff…' : 'View diff'}</summary><pre>{diff || 'No diff loaded.'}</pre></details>
        <label className="guided-review-note">Review note<textarea value={noteText || currentNote?.note || ''} onChange={(event) => setNoteText(event.target.value)} placeholder="Decision, question, risk, or test to run" /></label>
        <div className="guided-review-statuses"><button onClick={() => update('understood')} type="button">Understood</button><button onClick={() => update('question')} type="button">Question</button><button onClick={() => update('needs-change')} type="button"><ShieldAlert size={12} />Needs change</button><button onClick={() => update('approved')} type="button"><CheckCircle2 size={12} />Approve</button></div>
      </section>}
    </>}
  </aside>;
}

function ReviewExplanation({ mode, path, diff }: { mode: ReviewMode; path: string; diff: string }): ReactNode {
  const additions = (diff.match(/^\+/gm) ?? []).length;
  const removals = (diff.match(/^-/gm) ?? []).length;
  const role = /(?:api|service|client|server|route)/i.test(path) ? 'a connection or service boundary' : /(?:test|spec)/i.test(path) ? 'automated verification' : /(?:style|css|theme)/i.test(path) ? 'the visual interface' : 'the application implementation';
  const copy = mode === 'novice'
    ? `This file is part of ${role}. Read the KAI explanation first, then use the diff to connect the before and after.`
    : mode === 'intermediate'
      ? `Check what imports this file, what it calls, and whether the ${additions} additions and ${removals} removals preserve its existing contract.`
      : `Inspect contract changes, side effects, error paths, ownership boundaries, and test coverage for this ${role} change.`;
  return <div className="guided-review-explanation"><p><strong>What to review</strong>{copy}</p><p><strong>Diff signal</strong>{additions} additions · {removals} removals</p><p><strong>How to test</strong>Open the affected flow, exercise success and failure paths, then run the nearest relevant check.</p></div>;
}
