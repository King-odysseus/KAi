import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<Id extends string> {
  id: Id;
  label: ReactNode;
  /** A count or marker after the label. */
  badge?: ReactNode;
}

/**
 * The one tab strip, an underlined tablist with the arrow-key behaviour a tablist is expected to have. It owns no
 * content: pages keep their own panels and state, which is why it is not Flowbite's Tabs, whose component renders
 * the panels itself. The look matches the Flowbite theme: the active tab takes the accent underline.
 */
export function TabBar<Id extends string>({ tabs, value, onChange, label, className = '' }: {
  tabs: readonly TabItem<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  label: string;
  className?: string;
}): ReactNode {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number, direction: 1 | -1): void => {
    const next = (index + direction + tabs.length) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowRight') { event.preventDefault(); move(index, 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(index, -1); }
  };
  return (
    <div role="tablist" aria-label={label} className={`flex flex-wrap gap-0.5 border-b border-[color:var(--border-soft)] px-5 ${className}`.trim()}>
      {tabs.map((tab, index) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border-0 px-3 py-2 text-[12.5px] focus:outline-none focus-visible:bg-[var(--bg-hover)] ${active ? 'bg-[var(--mint-soft)] text-[var(--text)]' : 'bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}
          >
            {tab.label}
            {tab.badge !== undefined && <span className="text-[11px] text-[var(--text-dim)]">{tab.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
