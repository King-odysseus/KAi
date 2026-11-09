import type { ReactNode } from 'react';

/**
 * One labelled group of controls inside the composer's run options panel.
 *
 * The panel holds a lot of unrelated choices, and a single wrapping row of them reads as one pile: nothing says which
 * control is about what. Each section gets a small heading and its own row, with space between sections, so a person
 * finds "how it runs" or "who plans" by its name rather than by working out what each menu does.
 */
export function OptionSection({ title, children, className = '' }: {
  title: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h4 className="m-0 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-dim)]">{title}</h4>
      <div className={`flex flex-wrap items-center gap-1.5 ${className}`.trim()}>{children}</div>
    </section>
  );
}
