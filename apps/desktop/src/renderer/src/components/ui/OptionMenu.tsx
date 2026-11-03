import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { UiButton } from '../UiButton';

export interface OptionMenuOption<T extends string> {
  value: T;
  label: string;
  /** A line under the label that says what the choice does. */
  description?: string;
  /** A heading above the first option that names this group; later options with the same group sit under it. */
  group?: string;
  disabled?: boolean;
}

/**
 * A compact picker that opens a list above its trigger: the composer's access, model, route and agent choices.
 *
 * The chosen option is marked with a check mark and a quiet fill. It never carries an accent bar down its left edge:
 * a bar reads as "this row is a card", and every row here is the same kind of thing.
 */
export function OptionMenu<T extends string>({ ariaLabel, className = '', disabled = false, icon, labelPrefix, onChange, options, title, value, tone }: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  /** Shown before the chosen label, as in "Access: Plan only". */
  labelPrefix?: string;
  onChange: (value: T) => void;
  options: readonly OptionMenuOption<T>[];
  title?: string;
  value: T;
  /** Outlines the trigger in a meaning colour, for a choice that cannot be used right now. */
  tone?: 'unavailable';
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const focusTimer = window.setTimeout(() => optionRefs.current[selectedIndex]?.focus(), 0);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, selectedIndex]);

  const choose = (option: OptionMenuOption<T>): void => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveFocus = (currentIndex: number, direction: 1 | -1): void => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const nextIndex = (currentIndex + direction * offset + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        optionRefs.current[nextIndex]?.focus();
        return;
      }
    }
  };

  const focusEdge = (fromStart: boolean): void => {
    const indexes = options.map((_, index) => index);
    if (!fromStart) indexes.reverse();
    for (const index of indexes) {
      if (options[index]?.disabled) continue;
      optionRefs.current[index]?.focus();
      return;
    }
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(index, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(index, -1); }
    else if (event.key === 'Home') { event.preventDefault(); focusEdge(true); }
    else if (event.key === 'End') { event.preventDefault(); focusEdge(false); }
  };

  return (
    <div ref={rootRef} className={`kai-option-menu relative inline-flex ${disabled ? 'opacity-60' : ''} ${className}`.trim()}>
      <UiButton
        ref={triggerRef}
        type="button"
        variant="secondary"
        className={`!min-h-6 !gap-1 !rounded-full !px-2 !text-[11px] ${tone === 'unavailable' ? '!border-[color:var(--waiting)] !text-[var(--waiting)]' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={title}
      >
        {icon}
        <span className="max-w-[9rem] truncate">{labelPrefix ? `${labelPrefix}: ` : ''}{selectedOption?.label ?? value}</span>
        <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180 text-[var(--accent)]' : ''}`} aria-hidden="true" />
      </UiButton>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute bottom-[calc(100%+6px)] left-0 z-[60] flex max-h-72 min-w-[11.5rem] max-w-[22rem] flex-col gap-px overflow-y-auto rounded-xl border border-[color:var(--border)] bg-[var(--bg-raised)] p-1 shadow-[0_14px_34px_rgba(0,0,0,0.4)]"
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            const startsGroup = Boolean(option.group) && option.group !== options[index - 1]?.group;
            return (
              <div key={option.value} className="contents">
                {startsGroup && <div role="presentation" className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-dim)]">{option.group}</div>}
              <button
                key={option.value}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => choose(option)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                className={`flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg border-0 px-2.5 py-1.5 text-left text-xs focus:outline-none focus-visible:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'bg-[var(--selection)] text-[var(--text)]' : 'bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.description && <small className="whitespace-normal text-[11px] leading-snug text-[var(--text-dim)]">{option.description}</small>}
                </span>
                {selected && <Check size={13} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />}
              </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
