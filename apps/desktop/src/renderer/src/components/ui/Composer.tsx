import { Textarea } from 'flowbite-react';
import { ArrowUp, Loader2, Pause, Play, Square } from 'lucide-react';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { IconButton } from './IconButton';

/**
 * What the composer's outline says about the run that owns it. Red while Auto or Autopilot is running or needs you,
 * amber while it is waiting, muted red once it has failed; nothing at all when no run owns the box. The colours are
 * the theme's meaning tokens, so the same four states read the same in every theme.
 */
export type ComposerTone = 'idle' | 'live' | 'waiting' | 'failed';

const TONE_BORDER: Record<ComposerTone, string> = {
  // The idle composer marks focus with a surface tint (see .kai-composer:focus-within), not a brighter border.
  // A run's state still colours the border: that is a status signal, not a selection highlight.
  idle: 'border-[color:var(--border)]',
  live: 'border-[color:var(--needs-you)]',
  waiting: 'border-[color:var(--waiting)]',
  failed: 'border-[color:var(--failed)]',
};

/**
 * The one message box: Workspace, Crew, Project Studio and the tutor all use it. A narrow, centred, rounded box with
 * an optional single status line on top, the input, and a toolbar underneath holding the pickers on the left and the
 * send, pause and stop controls on the right. What differs between screens is what they put in those slots.
 */
export function Composer({ tone = 'idle', status, children, className = '' }: {
  tone?: ComposerTone;
  /** The one line about what the run is doing now; shown above the input. */
  status?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div data-tour="composer" className={`kai-composer mx-auto w-full max-w-[var(--composer-max)] rounded-[var(--radius-composer)] border bg-[var(--bg-panel)] px-3.5 pb-2.5 pt-2.5 ${TONE_BORDER[tone]} ${className}`.trim()}>
      {status && <div className="flex items-center gap-2 pb-2 text-xs text-[var(--text-muted)]" role="status">{status}</div>}
      {children}
    </div>
  );
}

/** The text field: no box of its own, since the composer is the box. */
export const ComposerInput = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Textarea>>(function ComposerInput({ className = '', rows = 1, ...props }, ref) {
  return (
    <Textarea
      ref={ref}
      rows={rows}
      className={`!block !w-full !resize-none !border-0 !bg-transparent !p-0 !pb-2 !text-sm !leading-5 !min-h-[28px] !shadow-none !outline-none !ring-0 focus:!border-0 focus:!ring-0 ${className}`.trim()}
      {...props}
    />
  );
});

/** The row under the input. `leading` holds the pickers, `actions` the send controls. */
export function ComposerToolbar({ leading, actions }: { leading?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <div data-tour="composer-toolbar" className="flex flex-wrap items-center gap-1.5">
      {leading && <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{leading}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Send. A message box without one is a box you cannot use with a mouse, so every composer has it. */
export function ComposerSend({ label = 'Send message', title, onClick, disabled = false, sending = false, icon, submit = false }: {
  label?: string;
  title?: string;
  /** Not needed when `submit` is set: the form's own submit handler runs instead. */
  onClick?: () => void;
  /** Make this the submit button of the surrounding form. */
  submit?: boolean;
  disabled?: boolean;
  sending?: boolean;
  icon?: ReactNode;
}): ReactNode {
  return <IconButton aria-label={label} title={title ?? label} variant="primary" type={submit ? 'submit' : 'button'} onClick={onClick} disabled={disabled} icon={sending ? <Loader2 className="spin" size={14} /> : (icon ?? <ArrowUp size={15} />)} />;
}

/** Stop, shown while a run is going. */
export function ComposerStop({ onClick, label = 'Stop agent' }: { onClick: () => void; label?: string }): ReactNode {
  return <IconButton aria-label={label} variant="danger" onClick={onClick} icon={<Square size={12} fill="currentColor" />} />;
}

/** Pause, and Resume once paused. */
export function ComposerPause({ paused, onPause, onResume }: { paused: boolean; onPause: () => void; onResume: () => void }): ReactNode {
  return <IconButton aria-label={paused ? 'Resume agent' : 'Pause agent'} variant="secondary" onClick={paused ? onResume : onPause} icon={paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />} />;
}
