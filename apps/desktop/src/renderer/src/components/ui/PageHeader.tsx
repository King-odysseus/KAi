import type { ReactNode } from 'react';

/**
 * The one page header: a title, a quiet line of detail, and the page's actions at the right. Every page uses it, so a
 * title never sits in a different place or size from one screen to the next. Actions wrap to their own row when the
 * window is narrow instead of squeezing the title.
 */
export function PageHeader({ title, detail, actions, children, status }: {
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  /** The same as `actions`, for a call site that nests its buttons inside the tag. */
  children?: ReactNode;
  /** A pill or two beside the title (the active project, a service's state). */
  status?: ReactNode;
}): ReactNode {
  return (
    <header className="kai-page-header flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--border-soft)] px-5 py-3">
      <h1 className="m-0 text-base font-semibold text-[var(--text)]">{title}</h1>
      {status}
      {detail && <p className="m-0 min-w-0 text-xs text-[var(--text-dim)]">{detail}</p>}
      {(actions ?? children) && <div className="ml-auto flex flex-wrap items-center gap-2">{actions ?? children}</div>}
    </header>
  );
}
