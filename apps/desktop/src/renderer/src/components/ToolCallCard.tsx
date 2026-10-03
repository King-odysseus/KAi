import { Check, ChevronDown, FileDiff, FilePlus, Loader2, MoveRight, Search, Terminal, Trash2, X } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { describeToolCall, renderToolCallPreview, type ToolCallPreview } from '../tool-call-preview';

type ToolCallEvent = Extract<PersistedEvent, { type: 'tool.call' }>;

/**
 * One edit or command, in the conversation where it happened: the header names the file or the
 * command, and the body shows the lines that changed. While the run is live the body is open;
 * once the turn ends the card is a single line that opens when the user asks for it.
 */
export const ToolCallCard = memo(function ToolCallCard({ event, defaultExpanded }: { event: ToolCallEvent; defaultExpanded: boolean }): ReactNode {
  // A user who opens or closes a card outranks the default, so the body does not move under them
  // when the run ends.
  const [override, setOverride] = useState<boolean | null>(null);
  const preview = useMemo(() => describeToolCall(event.name, event.input, event.output), [event]);
  const view = useMemo(() => (preview ? renderToolCallPreview(preview) : null), [preview]);
  // Arguments that the tool schema rejects leave nothing to show, but hiding the call would be
  // worse than a plain line.
  if (!preview || !view) {
    return <div className={`run-event tool ${event.status}`}><span>Tool</span><strong>{event.name}</strong><small>{event.status}</small></div>;
  }

  const failed = event.status === 'failed';
  const unapplied = failed && preview.kind !== 'command' && preview.kind !== 'explore';
  const hasBody = view.lines.length > 0 || view.note !== null || unapplied;
  const expanded = hasBody && (override ?? defaultExpanded);

  const header = (
    <>
      {hasBody && <ChevronDown className="tool-call-chevron" size={13} />}
      <span className="tool-call-icon">{iconFor(preview)}</span>
      <span className="tool-call-verb">{view.verb}</span>
      <strong className="truncate" title={view.target}>{view.target}</strong>
      {view.added > 0 && <span className="diff-add">+{view.added}</span>}
      {view.removed > 0 && <span className="diff-remove">-{view.removed}</span>}
      <span className="tool-call-status" title={statusWord(event.status)}>{statusMark(event.status)}</span>
    </>
  );

  return (
    <section className={`tool-call-card ${preview.kind}${failed ? ' failed' : ''}`}>
      {hasBody ? (
        <button type="button" className="tool-call-head" aria-expanded={expanded} title={expanded ? 'Hide the change' : 'Show the change'} onClick={() => setOverride(!expanded)}>
          {header}
        </button>
      ) : (
        <div className="tool-call-head">{header}</div>
      )}
      {expanded && (
        <div className="tool-call-body">
          {view.note && <p className="tool-call-note">{view.note}</p>}
          {view.lines.length > 0 && (
            <pre className="tool-call-lines">
              {view.lines.map((line, index) => (
                <div key={index} className={`hunk-line ${line.kind}`}>{prefixFor(line.kind)}{line.text}</div>
              ))}
            </pre>
          )}
          {preview.kind === 'command' && view.lines.length === 0 && <p className="tool-call-note">No output</p>}
          {unapplied && <p className="tool-call-note failed">This change was not applied.</p>}
        </div>
      )}
    </section>
  );
});

function iconFor(preview: ToolCallPreview): ReactNode {
  if (preview.kind === 'edit') return <FileDiff size={12} />;
  if (preview.kind === 'write') return <FilePlus size={12} />;
  if (preview.kind === 'delete') return <Trash2 size={12} />;
  if (preview.kind === 'move') return <MoveRight size={12} />;
  if (preview.kind === 'explore') return <Search size={12} />;
  return <Terminal size={12} />;
}

function statusMark(status: ToolCallEvent['status']): ReactNode {
  if (status === 'completed') return <Check size={12} />;
  if (status === 'failed') return <X size={12} />;
  return <Loader2 className="spin" size={12} />;
}

function statusWord(status: ToolCallEvent['status']): string {
  if (status === 'completed') return 'Done';
  if (status === 'failed') return 'Failed';
  return 'Running';
}

function prefixFor(kind: 'context' | 'removed' | 'added' | 'gap'): string {
  if (kind === 'removed') return '- ';
  if (kind === 'added') return '+ ';
  return kind === 'gap' ? '' : '  ';
}
