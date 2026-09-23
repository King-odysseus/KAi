import { BookmarkPlus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { unwrap } from '../types';

type EntryType = 'bugs' | 'decisions' | 'gotchas' | 'patterns';

const TYPES: Array<{ id: EntryType; label: string; hint: string }> = [
  { id: 'bugs', label: 'Bug and fix', hint: 'A problem that was solved' },
  { id: 'decisions', label: 'Decision', hint: 'A choice and why it was made' },
  { id: 'gotchas', label: 'Gotcha', hint: 'A trap to avoid next time' },
  { id: 'patterns', label: 'Pattern', hint: 'A technique worth reusing' },
];

const MAX_NOTE = 4_000;

function guessTitle(text: string): string {
  const first = text.split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? 'Learned in KAI';
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

interface LearnResult {
  ok?: boolean;
  rejected?: boolean;
  duplicate?: boolean;
  reason?: string;
}

/**
 * Turns an assistant reply into a C1 brain entry the user can edit first. C1 has no dry-run for
 * learning, so its quality gate and duplicate check are reported straight after the save attempt;
 * a rejected entry is not written, and can be forced through.
 */
export function SaveToBrainDialog({ text, project, onClose, onSaved }: { text: string; project: string; onClose: () => void; onSaved: (message: string) => void }): ReactNode {
  const [type, setType] = useState<EntryType>('patterns');
  const [title, setTitle] = useState(() => guessTitle(text));
  const [note, setNote] = useState(() => text.slice(0, MAX_NOTE));
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; canForce: boolean } | null>(null);

  async function save(force: boolean): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const result = unwrap(await window.kaiDesktop.cognitive1Operation({
        operation: 'brain-learn',
        payload: { type, project, title: title.trim(), note: note.trim(), tags: tags.trim(), agent: 'kai-desktop', ...(force ? { force: true } : {}) },
      })) as LearnResult;
      if (result.rejected) {
        setProblem({ message: `The brain's quality check rejected this entry: ${result.reason ?? 'not specific enough'}.`, canForce: true });
      } else if (result.duplicate) {
        setProblem({ message: 'A very similar entry already exists, so nothing new was written.', canForce: true });
      } else {
        onSaved(`Saved "${title.trim()}" to the brain.`);
        onClose();
      }
    } catch (caught) {
      setProblem({ message: caught instanceof Error ? caught.message : 'The entry could not be saved.', canForce: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skills-overlay" role="dialog" aria-modal="true" aria-label="Save to Brain">
      <div className="skills-panel brain-save-panel">
        <div className="skills-panel-head">
          <div><span className="eyebrow">C1 Brain</span><h2>Save to Brain</h2></div>
          <button type="button" className="icon-button compact" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="brain-save-form">
          <div className="field-grid">
            <label className="field"><span>Kind</span><select value={type} onChange={(event) => setType(event.target.value as EntryType)}>{TYPES.map((item) => <option key={item.id} value={item.id}>{item.label} — {item.hint}</option>)}</select></label>
            <label className="field"><span>Project</span><input value={project} readOnly /></label>
          </div>
          <label className="field"><span>Title</span><input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field"><span>What to remember</span><textarea rows={8} value={note} maxLength={MAX_NOTE} onChange={(event) => setNote(event.target.value)} /></label>
          <label className="field"><span>Tags (comma separated)</span><input value={tags} placeholder="frontend, css" onChange={(event) => setTags(event.target.value)} /></label>
          {problem && <div className="workbench-error" role="alert">{problem.message}</div>}
          <div className="ops-actions">
            <button type="button" className="primary-button" disabled={busy || !title.trim() || !note.trim()} onClick={() => void save(false)}><BookmarkPlus size={14} /><span>{busy ? 'Saving…' : 'Save'}</span></button>
            {problem?.canForce && <button type="button" className="secondary-button" disabled={busy} onClick={() => void save(true)}>Save anyway</button>}
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
