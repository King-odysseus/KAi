import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiButton } from '../UiButton';

/**
 * A row's "⋮" actions menu, drawn with the same portal-and-list approach as `Select` in this folder — proven to
 * render in the app's own theme — rather than Flowbite's `Dropdown`, whose floating content came out as a stack of
 * separate boxed, shadowed buttons instead of a flat themed menu. Unlike `Select` this never tracks or shows a
 * "current" value and never explicitly refocuses the trigger after a choice: it is a list of one-shot actions, not
 * a value picker, and an explicit `.focus()` call is exactly what makes a browser treat the next render as needing
 * a focus-visible indicator, which is the extra border this exists to avoid.
 */

export interface ActionsMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

const POPOVER_GAP = 4;
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_WIDTH = 200;

export function ActionsMenu({
  items,
  trigger,
  ariaLabel,
}: {
  items: readonly ActionsMenuItem[];
  trigger: (props: { onClick: () => void; expanded: boolean }) => ReactNode;
  ariaLabel: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const anchorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Placed against the trigger's right edge (these sit at the end of a row), below it when there is room and above
  // it otherwise — the same placement rule `Select` uses, so every popover in the app opens the same way.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      const below = window.innerHeight - rect.bottom - POPOVER_GAP - 8;
      const above = rect.top - POPOVER_GAP - 8;
      const upward = below < Math.min(POPOVER_MAX_HEIGHT, items.length * 32) && above > below;
      const maxHeight = Math.max(120, Math.min(POPOVER_MAX_HEIGHT, upward ? above : below));
      const left = Math.min(Math.max(8, rect.right - POPOVER_WIDTH), window.innerWidth - POPOVER_WIDTH - 8);
      setPosition(upward
        ? { left, width: POPOVER_WIDTH, maxHeight, bottom: window.innerHeight - rect.top + POPOVER_GAP }
        : { left, width: POPOVER_WIDTH, maxHeight, top: rect.bottom + POPOVER_GAP });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  return (
    <div ref={anchorRef} className="actions-menu-anchor">
      {trigger({ onClick: () => setOpen((value) => !value), expanded: open })}
      {open && createPortal(
        <div ref={listRef} className="kai-select-list" role="menu" aria-label={ariaLabel} style={position}>
          {items.map((item) => (
            <UiButton
              key={item.key}
              type="button"
              role="menuitem"
              className="kai-select-option actions-menu-item"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.icon}
              <span>{item.label}</span>
            </UiButton>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
