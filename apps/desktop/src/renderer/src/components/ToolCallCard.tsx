import { Check, ChevronDown, FileDiff, FilePlus, Globe, Loader2, Minus, MoveRight, Search, Terminal, Trash2, X } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { describeToolCall, renderToolCallPreview, type ToolCallPreview } from '../tool-call-preview';

type ToolCallEvent = Extract<PersistedEvent, { type: 'tool.call' }>;

export type ToolCallMark = 'check' | 'x' | 'spin' | 'dash';

/**
 * How a tool call should read, given whether the run it belongs to is still going.
 *
 * A call is stored as `started` and only flips to a finished status when its result arrives. A run that died with
 * the process never delivers one, so the stored status alone would render those calls as in flight forever. The
 * second argument is what tells a genuinely running call apart from one nobody is running any more.
 */
export function toolCallStatus(status: ToolCallEvent['status'], runActive: boolean): { mark: ToolCallMark; word: string } {
  if (status === 'completed') return { mark: 'check', word: 'Done' };
  if (status === 'failed') return { mark: 'x', word: 'Failed' };
  return runActive ? { mark: 'spin', word: 'Running' } : { mark: 'dash', word: 'Interrupted' };
}

/**
 * One edit or command, in the conversation where it happened: the header names the file or the
 * command, and the body shows the lines that changed. While the run is live the body is open;
 * once the turn ends the card is a single line that opens when the user asks for it.
 */
export const ToolCallCard = memo(function ToolCallCard({ event, defaultExpanded, runActive }: { event: ToolCallEvent; defaultExpanded: boolean; runActive: boolean }): ReactNode {
  // A user who opens or closes a card outranks the default, so the body does not move under them
  // when the run ends.
  const [override, setOverride] = useState<boolean | null>(null);
  const status = toolCallStatus(event.status, runActive);
  const preview = useMemo(() => describeToolCall(event.name, event.input, event.output), [event]);
  const view = useMemo(() => (preview ? renderToolCallPreview(preview) : null), [preview]);
  // Arguments that the tool schema rejects leave nothing to show, but hiding the call would be
  // worse than a plain line.
  if (!preview || !view) {
    return <div className={`run-event tool ${event.status}`}><span>Tool</span><strong>{event.name}</strong><small>{status.word}</small></div>;
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
      <span className="tool-call-status" title={status.word}>{statusMark(status.mark)}</span>
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
  if (preview.kind === 'explore' || preview.kind === 'search') return <Search size={12} />;
  if (preview.kind === 'fetch') return <Globe size={12} />;
  return <Terminal size={12} />;
}

function statusMark(mark: ToolCallMark): ReactNode {
  if (mark === 'check') return <Check size={12} />;
  if (mark === 'x') return <X size={12} />;
  if (mark === 'dash') return <Minus size={12} />;
  return <Loader2 className="spin" size={12} />;
}

function prefixFor(kind: 'context' | 'removed' | 'added' | 'gap'): string {
  if (kind === 'removed') return '- ';
  if (kind === 'added') return '+ ';
  return kind === 'gap' ? '' : '  ';
}
