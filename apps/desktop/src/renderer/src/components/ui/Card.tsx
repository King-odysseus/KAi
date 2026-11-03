import { Card as FlowbiteCard } from 'flowbite-react';
import type { ReactNode } from 'react';

/**
 * The one card: a Flowbite Card on the app's panel colours. A titled card says what it holds in a header line; a
 * `tone` outlines it in a meaning colour (needs you, waiting) instead of inventing a new box.
 */
export function Card({ title, actions, tone, className = '', children }: {
  title?: ReactNode;
  actions?: ReactNode;
  tone?: 'needs-you' | 'waiting' | 'success';
  className?: string;
  children?: ReactNode;
}): ReactNode {
  const toneClass = tone === 'needs-you' ? '!border-[color:var(--needs-you)]' : tone === 'waiting' ? '!border-[color:var(--waiting)]' : tone === 'success' ? '!border-[color:var(--success)]' : '';
  return (
    <FlowbiteCard className={`kai-card ${toneClass} ${className}`.trim()}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-2">
          {title && <h2 className="m-0 text-[13px] font-semibold text-[var(--text)]">{title}</h2>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </FlowbiteCard>
  );
}
