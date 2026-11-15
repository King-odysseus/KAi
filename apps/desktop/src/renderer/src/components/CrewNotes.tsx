import { BellRing, ScrollText } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { buildDecisions, type CrewRun } from '@kai/contracts';
import { UiButton } from './UiButton';

/**
 * Two short lists for the person, kept out of the way: what reviewers noticed that did not stop a task (so a worry about
 * an upgrade does not send work round in circles, and is not lost either), and the decisions made on this crew.
 */
export function CrewNotes({ run, busy, onClear }: { run: CrewRun; busy: boolean; onClear: () => void }): ReactNode {
  const decisions = useMemo(() => buildDecisions(run), [run]);
  const roleLabel = (id: string): string => run.config.roles.find((role) => role.id === id)?.label ?? id;
  const taskTitle = (id: string): string => run.tasks.find((task) => task.id === id)?.title ?? id;
  if (run.notes.length === 0 && decisions.length === 0) return null;
  return (
    <section className="ops-panel crew-notes" aria-label="Notes and decisions">
      {run.notes.length > 0 && (
        <details open>
          <summary><BellRing size={14} /> Notes for you ({run.notes.length})</summary>
          <p className="tasks-tab-help">Things the reviewers noticed. None of them stopped a task; they are here for you to decide on.</p>
          <ul className="crew-list">
            {run.notes.map((note) => <li key={note.id}><strong>{roleLabel(note.role)}</strong> on “{taskTitle(note.taskId)}”: {note.text}</li>)}
          </ul>
          <UiButton type="button" className="secondary-button" disabled={busy} onClick={onClear}>Clear notes</UiButton>
        </details>
      )}
      {decisions.length > 0 && (
        <details>
          <summary><ScrollText size={14} /> Decisions so far ({decisions.length})</summary>
          <ul className="crew-list">
            {decisions.slice(-40).map((item, index) => <li key={`${item.at}-${index}`}><small>{new Date(item.at).toLocaleString()}</small> {item.kind === 'learned' ? 'Learned: ' : ''}{item.text}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
