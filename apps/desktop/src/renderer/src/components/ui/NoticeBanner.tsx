import { Ellipsis, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ActionsMenu, type ActionsMenuItem } from './ActionsMenu';
import { IconButton } from './IconButton';

const TONE: Record<'info' | 'waiting' | 'danger', string> = {
  info: 'border-[color:var(--border)] bg-[var(--bg-raised)]',
  waiting: 'border-[color:var(--waiting)] bg-[var(--warning-soft)]',
  danger: 'border-[color:var(--danger)] bg-[var(--danger-soft)]',
};

/**
 * A notice with a sentence and at most one button in view. Anything else the person could do about it sits in the
 * ⋯ menu, so a notice never grows a row of buttons that runs out of room and squeezes its own text.
 */
export function NoticeBanner({ tone = 'info', children, primary, more, onDismiss }: {
  tone?: 'info' | 'waiting' | 'danger';
  children: ReactNode;
  /** The one action worth a button: usually the thing the notice is asking for. */
  primary?: ReactNode;
  /** The rest, in a menu. */
  more?: readonly ActionsMenuItem[];
  onDismiss?: () => void;
}): ReactNode {
  return (
    <div role="status" className={`flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--radius-control)] border px-3 py-1.5 text-xs text-[var(--text-muted)] ${TONE[tone]}`}>
      {/* The sentence keeps a readable width: when the buttons beside it would squeeze it, they drop to the next line instead. */}
      <span className="min-w-[min(100%,16rem)] flex-1 basis-64 whitespace-normal [overflow-wrap:anywhere]">{children}</span>
      {primary}
      {more && more.length > 0 && (
        <ActionsMenu
          ariaLabel="More actions"
          items={more}
          trigger={({ onClick, expanded }) => <IconButton aria-label="More actions" aria-expanded={expanded} onClick={onClick} icon={<Ellipsis size={14} />} />}
        />
      )}
      {onDismiss && <IconButton aria-label="Dismiss notice" onClick={onDismiss} icon={<X size={13} />} />}
    </div>
  );
}
