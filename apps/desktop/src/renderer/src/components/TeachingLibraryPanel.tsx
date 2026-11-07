import {
  FilePlus2,
  FileText,
  ListPlus,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  TeachingDraft,
  TeachingDraftGenerateInput,
  TeachingLibrary,
  TeachingLibraryEntry,
  TeachingLibraryEntryInput,
  TeachingLibraryKind,
  TeachingLibrarySaveInput,
} from '@kai/contracts';
import { UiButton } from './UiButton';
import { Textarea } from 'flowbite-react';
import { Toggle } from './ui/Toggle';
import { UiTextInput } from './UiTextInput';

interface TeachingLibraryPanelProps {
  library: TeachingLibrary | null;
  busy: string | null;
  onSave: (input: TeachingLibrarySaveInput) => Promise<void>;
  onDelete: (input: TeachingLibraryEntryInput) => Promise<void>;
  onReset: (input: TeachingLibraryEntryInput) => Promise<void>;
  onGenerate: (input: TeachingDraftGenerateInput) => Promise<TeachingDraft>;
}

interface EntryDraft {
  id: string;
  kind: TeachingLibraryKind;
  title: string;
  description: string;
  content: string;
  enabled: boolean;
  builtIn: boolean;
}

export function TeachingLibraryPanel({
  library,
  busy,
  onSave,
  onDelete,
  onReset,
  onGenerate,
}: TeachingLibraryPanelProps): ReactNode {
  const [kind, setKind] = useState<TeachingLibraryKind>('method');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [topic, setTopic] = useState('');
  const [instructions, setInstructions] = useState('');

  const entries = entriesFor(library, kind);

  useEffect(() => {
    if (!library) return;
    const existing = entries.find((entry) => entry.id === selectedId) ?? null;
    if (!existing && draft?.id === selectedId && draft.kind === kind) return;
    const selected = existing ?? entries[0] ?? null;
    setSelectedId(selected?.id ?? null);
    setDraft(selected ? draftFromEntry(selected) : null);
  }, [draft?.id, draft?.kind, kind, library, selectedId]);

  function selectEntry(entry: TeachingLibraryEntry): void {
    setSelectedId(entry.id);
    setDraft(draftFromEntry(entry));
  }

  function createEntry(): void {
    const id = `custom-${kind}-${randomId()}`;
    setSelectedId(id);
    setDraft({
      id,
      kind,
      title: kind === 'method' ? 'New KAI teaching method' : 'New KAI teaching rule pack',
      description: '',
      content: kind === 'method' ? newMethodTemplate() : newRuleTemplate(),
      enabled: true,
      builtIn: false,
    });
  }

  async function saveDraft(): Promise<void> {
    if (!draft || !draft.title.trim() || !draft.content.trim()) return;
    try {
      await onSave({
        id: draft.id,
        kind: draft.kind,
        title: draft.title,
        description: draft.description,
        content: draft.content,
        enabled: draft.enabled,
      });
    } catch {
      // The parent reports the actionable error beside the learning panel.
    }
  }

  async function deleteDraft(): Promise<void> {
    if (!draft || draft.builtIn) return;
    try {
      await onDelete({ id: draft.id, kind: draft.kind });
      setSelectedId(null);
      setDraft(null);
    } catch {
      // The parent reports the actionable error beside the learning panel.
    }
  }

  async function resetDraft(): Promise<void> {
    if (!draft || !draft.builtIn) return;
    try {
      await onReset({ id: draft.id, kind: draft.kind });
    } catch {
      // The parent reports the actionable error beside the learning panel.
    }
  }

  async function generateDraft(): Promise<void> {
    if (!topic.trim()) return;
    try {
      const generated = await onGenerate({
        kind,
        topic: topic.trim(),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(draft?.content ? { baseContent: draft.content } : {}),
      });
      const draftIsUnsaved = Boolean(draft && !draft.builtIn && !entries.some((entry) => entry.id === draft.id));
      const id = draftIsUnsaved && draft ? draft.id : `custom-${kind}-${randomId()}`;
      setSelectedId(id);
      setDraft({
        id,
        kind,
        title: generated.title,
        description: generated.description,
        content: generated.content,
        enabled: true,
        builtIn: false,
      });
    } catch {
      // The parent reports the actionable error beside the learning panel.
    }
  }

  function duplicateDraft(): void {
    if (!draft) return;
    const id = `custom-${kind}-${randomId()}`;
    setSelectedId(id);
    setDraft({
      ...draft,
      id,
      title: `${draft.title} copy`.slice(0, 200),
      builtIn: false,
    });
  }

  const saving = busy === `save:${kind}`;
  const deleting = busy === `delete:${kind}`;
  const resetting = busy === `reset:${kind}`;
  const generating = busy === `generate:${kind}`;

  return (
    <div className="teaching-library">
      <div className="teaching-kind-tabs" role="tablist" aria-label="Teaching library type">
        <UiButton type="button" role="tab" aria-selected={kind === 'method'} className={kind === 'method' ? 'active' : ''} onClick={() => setKind('method')}>
          <FileText size={13} />Methods
        </UiButton>
        <UiButton type="button" role="tab" aria-selected={kind === 'rule'} className={kind === 'rule' ? 'active' : ''} onClick={() => setKind('rule')}>
          <ShieldCheck size={13} />Rules
        </UiButton>
      </div>

      <div className="teaching-library-actions">
        <UiButton type="button" className="secondary-button" disabled={Boolean(busy)} onClick={createEntry}>
          {kind === 'method' ? <FilePlus2 size={13} /> : <ListPlus size={13} />}New
        </UiButton>
        {draft && !draft.builtIn && (
          <UiButton type="button" className="secondary-button danger-button" disabled={Boolean(busy)} onClick={() => void deleteDraft()}>
            {deleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}Delete
          </UiButton>
        )}
        {draft?.builtIn && (
          <UiButton type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void resetDraft()}>
            {resetting ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}Reset
          </UiButton>
        )}
      </div>

      {library ? (
        <>
          <small className="teaching-location" title={library.directory}>KAI-owned Markdown: {library.directory}</small>
          <div className="teaching-entry-list">
            {entries.map((entry) => (
              <UiButton
                key={entry.id}
                type="button"
                className={`teaching-entry ${selectedId === entry.id ? 'active' : ''} ${entry.enabled ? '' : 'disabled'}`}
                onClick={() => selectEntry(entry)}
              >
                <span className="teaching-entry-mark">{entry.kind === 'method' ? <FileText size={13} /> : <ShieldCheck size={13} />}</span>
                <span className="teaching-entry-copy"><strong>{entry.title}</strong><small>{entry.description || 'No description'}</small></span>
                <span className={`teaching-entry-state ${entry.enabled ? 'enabled' : ''}`}>{entry.enabled ? 'On' : 'Off'}</span>
              </UiButton>
            ))}
            {!entries.length && <div className="learning-empty compact"><FileText size={18} /><strong>No {kind} entries</strong><p>Create one or generate a draft.</p></div>}
          </div>
        </>
      ) : (
        <div className="learning-empty compact"><LoaderCircle className="spin" size={18} /><strong>Loading teaching library</strong></div>
      )}

      {draft && (
        <section className="teaching-editor" aria-label="Teaching entry editor">
          <div className="teaching-editor-head">
            <div><strong>{draft.builtIn ? 'Built-in KAI entry' : 'Custom KAI entry'}</strong><small>{draft.builtIn ? 'Editable, and can be reset' : 'Saved under your KAI data folder'}</small></div>
            <div className="teaching-enabled"><span>{draft.enabled ? 'Enabled' : 'Disabled'}</span><Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} ariaLabel="Use this entry when teaching" /></div>
          </div>
          <label><span>Title</span><UiTextInput value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label><span>Description</span><UiTextInput value={draft.description} maxLength={1_000} placeholder="When should KAI use this?" onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label><span>Markdown</span><Textarea value={draft.content} rows={16} spellCheck={false} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
          <div className="teaching-editor-actions">
            <UiButton type="button" className="secondary-button" disabled={Boolean(busy)} onClick={duplicateDraft}><FilePlus2 size={13} />Duplicate</UiButton>
            <UiButton type="button" className="primary-button" disabled={Boolean(busy) || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveDraft()}>
              {saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}Save entry
            </UiButton>
          </div>
        </section>
      )}

      <section className="teaching-generate" aria-label="Generate a teaching draft">
        <div><WandSparkles size={14} /><strong>Generate a draft</strong></div>
        <p>The provider writes a review draft. Nothing is saved until you choose Save entry.</p>
        <UiTextInput value={topic} maxLength={500} placeholder="e.g. debugging async race conditions" onChange={(event) => setTopic(event.target.value)} />
        <Textarea value={instructions} rows={3} placeholder="Optional requirements for the method or rules" onChange={(event) => setInstructions(event.target.value)} />
        <div className="teaching-editor-actions">
          <UiButton type="button" className="primary-button" disabled={Boolean(busy) || !topic.trim()} onClick={() => void generateDraft()}>
            {generating ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />}Generate draft
          </UiButton>
        </div>
      </section>
    </div>
  );
}

function entriesFor(library: TeachingLibrary | null, kind: TeachingLibraryKind): TeachingLibraryEntry[] {
  return kind === 'method' ? library?.methods ?? [] : library?.rules ?? [];
}

function draftFromEntry(entry: TeachingLibraryEntry): EntryDraft {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    description: entry.description,
    content: entry.content,
    enabled: entry.enabled,
    builtIn: entry.builtIn,
  };
}

function randomId(): string {
  const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/[^a-z0-9-]/gi, '').toLowerCase()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return value.slice(0, 36);
}

function newMethodTemplate(): string {
  return `# Custom KAI teaching method

## Use when

Describe the learner situation where this method is appropriate.

## Teaching sequence

1. Recap the previous confirmed idea.
2. State the immediate learning outcome.
3. Explain the code and analogy before asking the learner to change it.
4. Ask a bounded question or task.
5. Verify the learner's reasoning with evidence.

## Evidence

Describe what counts as independent evidence and what does not.

## Boundaries

State where this method must stop.
`;
}

function newRuleTemplate(): string {
  return `# Custom KAI teaching rules

1. Write each rule as a specific, testable instruction.
2. Define the learner evidence that satisfies the rule.
3. State any safety or learner-agency boundary.
`;
}
