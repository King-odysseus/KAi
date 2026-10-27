import type { ReactNode } from 'react';
import { Badge } from 'flowbite-react';

export type PillTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** One compact status treatment across Workspace, Studio, Tasks, Settings, and Git. */
export function Pill({ children, tone = 'neutral', className = '', title, role, 'aria-label': ariaLabel, 'aria-live': ariaLive }: {
  children: ReactNode;
  tone?: PillTone;
  className?: string;
  title?: string;
  role?: 'status';
  'aria-label'?: string;
  'aria-live'?: 'polite';
}): ReactNode {
  const color = tone === 'neutral' ? 'gray' : tone === 'error' ? 'failure' : tone;
  return <Badge color={color} size="xs" className={`kai-pill ${className}`} title={title} role={role} aria-label={ariaLabel} aria-live={ariaLive}>{children}</Badge>;
}
