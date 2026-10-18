import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

/**
 * A right-click menu for the file lists and editor tabs. It is rendered in a portal so a scroll container cannot
 * clip it, and it clamps itself to the window so a click near an edge still shows every item.
 */
export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}): ReactNode {
  const menu = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const leave = (): void => onClose();
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('contextmenu', outside, true);
    window.addEventListener('keydown', escape);
    window.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => {
      window.removeEventListener('mousedown', outside, true);
      window.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', leave, true);
      window.removeEventListener('resize', leave);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menu}
      className="context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (item.separator ? (
        <div key={`separator-${index}`} className="context-menu-separator" role="separator" />
      ) : (
        <button
          key={`${item.label}-${index}`}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      )))}
    </div>,
    document.body,
  );
}
