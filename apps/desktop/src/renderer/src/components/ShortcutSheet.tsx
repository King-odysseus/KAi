import { AlertTriangle, Check, Keyboard, RotateCcw, X } from 'lucide-react';
import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { DEFAULT_DESKTOP_SHORTCUTS, type AppSettings } from '@kai/contracts';
import { SHORTCUT_DEFINITIONS, shortcutConflicts, shortcutFromEvent, shortcutsWithDefaults } from '../shortcuts';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';
import { Dialog } from './ui/Dialog';

type DesktopShortcuts = AppSettings['shortcuts'];

export function ShortcutEditor({
  shortcuts,
  onChange,
  disabled = false,
}: {
  shortcuts: DesktopShortcuts;
  onChange: (shortcuts: DesktopShortcuts) => void;
  disabled?: boolean;
}): ReactNode {
  const merged = shortcutsWithDefaults(shortcuts);
  const conflicts = shortcutConflicts(merged);

  function capture(event: ReactKeyboardEvent<HTMLInputElement>, id: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      onChange({ ...merged, [id]: DEFAULT_DESKTOP_SHORTCUTS[id] ?? merged[id] });
      return;
    }
    if (event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    const shortcut = shortcutFromEvent(event);
    if (shortcut) onChange({ ...merged, [id]: shortcut });
  }

  return (
    <div className="shortcut-editor">
      <div className="shortcut-list">
        {SHORTCUT_DEFINITIONS.map((definition) => (
          <label className="shortcut-row" key={definition.id}>
            <span>
              <strong>{definition.label}</strong>
              <small>{definition.description}</small>
            </span>
            <UiTextInput
              className="shortcut-capture"
              value={merged[definition.id] ?? ''}
              readOnly
              disabled={disabled}
              aria-label={`Shortcut for ${definition.label}`}
              title="Focus and press a key combination. Backspace restores the default."
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => capture(event, definition.id)}
            />
            <UiButton
              type="button"
              className="icon-button compact"
              disabled={disabled || merged[definition.id] === DEFAULT_DESKTOP_SHORTCUTS[definition.id]}
              aria-label={`Reset ${definition.label} shortcut`}
              title="Reset to default"
              onClick={() => onChange({ ...merged, [definition.id]: DEFAULT_DESKTOP_SHORTCUTS[definition.id] ?? merged[definition.id] })}
            >
              <RotateCcw size={13} />
            </UiButton>
          </label>
        ))}
      </div>
      {conflicts.length > 0 && (
        <div className="shortcut-conflict" role="alert">
          <AlertTriangle size={14} />
          <span>{conflicts[0]}</span>
        </div>
      )}
    </div>
  );
}

export function ShortcutSheet({
  shortcuts,
  busy,
  onSave,
  onClose,
}: {
  shortcuts: DesktopShortcuts;
  busy: boolean;
  onSave: (shortcuts: DesktopShortcuts) => Promise<boolean>;
  onClose: () => void;
}): ReactNode {
  const [draft, setDraft] = useState<DesktopShortcuts>(() => shortcutsWithDefaults(shortcuts));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const conflicts = shortcutConflicts(draft);

  async function save(): Promise<void> {
    if (conflicts.length > 0) return;
    setSaving(true);
    const success = await onSave(draft);
    setSaved(success);
    setSaving(false);
  }

  return (
    <Dialog size="3xl" dismissible onClose={onClose} titleId="shortcut-sheet-title">
      <section className="shortcut-sheet">
        <header className="shortcut-sheet-head">
          <div className="shortcut-sheet-title">
            <span className="shortcut-sheet-icon"><Keyboard size={18} /></span>
            <div>
              <span className="eyebrow">Keyboard</span>
              <h2 id="shortcut-sheet-title">Shortcut sheet</h2>
              <p>Focus a shortcut and press the key combination you want. Changes are shared across KAI windows.</p>
            </div>
          </div>
          <UiButton type="button" className="icon-button" aria-label="Close shortcut sheet" onClick={onClose}><X size={17} /></UiButton>
        </header>
        <ShortcutEditor shortcuts={draft} onChange={(next) => { setDraft(next); setSaved(false); }} disabled={saving || busy} />
        <footer className="shortcut-sheet-footer">
          <span className={saved ? 'shortcut-saved' : 'settings-note'}>
            {saved ? <><Check size={13} /> Saved and active now</> : 'Defaults are restored with Backspace on a focused shortcut.'}
          </span>
          <div className="button-row">
            <UiButton type="button" className="secondary-button" disabled={saving || busy} onClick={() => { setDraft(shortcutsWithDefaults({})); setSaved(false); }}>
              <RotateCcw size={14} /><span>Reset all</span>
            </UiButton>
            <UiButton type="button" className="primary-button" disabled={saving || busy || conflicts.length > 0} onClick={() => void save()}>
              <Check size={14} /><span>{saving ? 'Saving' : 'Save shortcuts'}</span>
            </UiButton>
          </div>
        </footer>
      </section>
    </Dialog>
  );
}
