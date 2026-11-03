import { Check, ChevronDown } from 'lucide-react';
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { UiButton } from '../UiButton';

/** What a change handler receives: the shape of a native select's change event, so existing handlers work as-is. */
export interface SelectChange {
  target: { value: string };
  currentTarget: { value: string };
}

export interface SelectProps {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChange) => void;
  children?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  title?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
}

interface ParsedOption {
  value: string;
  label: string;
  disabled: boolean;
}

interface OptionProps {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Reads `<option>` children, including ones inside fragments and mapped arrays. */
function parseOptions(children: ReactNode): ParsedOption[] {
  const options: ParsedOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<OptionProps & { children?: ReactNode }>;
    if (element.type === 'option') {
      const label = textOf(element.props.children);
      options.push({ value: String(element.props.value ?? label), label, disabled: Boolean(element.props.disabled) });
    } else {
      options.push(...parseOptions(element.props.children));
    }
  });
  return options;
}

const POPOVER_GAP = 4;
const POPOVER_MAX_HEIGHT = 280;

/**
 * KAI's dropdown: a drop-in for a native `<select>` (same props, `<option>` children and `event.target.value`
 * handler), drawn in the app's own style instead of the operating system's. The list opens in a layer above the
 * page, so a card that clips its overflow never cuts it off.
 */
export function Select({
  value, defaultValue, onChange, children, disabled = false, id, name, className = '', title,
  'aria-label': ariaLabel, 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedBy,
}: SelectProps): ReactNode {
  const options = parseOptions(children);
  const [uncontrolled, setUncontrolled] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const current = value === undefined ? uncontrolled : String(value);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === current));
  const selected = options.find((option) => option.value === current);

  // Placed against the trigger, below it when there is room and above it otherwise. It follows the trigger while
  // the page scrolls, and closes only once the trigger has scrolled out of sight.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      if (rect.bottom < 0 || rect.top > viewportHeight) {
        setOpen(false);
        return;
      }
      // The list is never taller than the room above or below the trigger. A minimum height (the old 120px floor)
      // could force it past the window edge when the trigger sat near the bottom; the list scrolls instead.
      const desired = Math.min(POPOVER_MAX_HEIGHT, options.length * 32, viewportHeight - 16);
      const below = viewportHeight - rect.bottom - POPOVER_GAP - 8;
      const above = rect.top - POPOVER_GAP - 8;
      const fitsBelow = below >= desired;
      const upward = !fitsBelow && (above >= desired || above > below);
      const maxHeight = Math.max(0, Math.min(desired, upward ? above : below));
      const width = Math.max(0, Math.min(Math.max(rect.width, 160), viewportWidth - 16));
      const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8));
      setPosition(upward
        ? { left, width, maxHeight, bottom: viewportHeight - rect.top + POPOVER_GAP }
        : { left, width, maxHeight, top: rect.bottom + POPOVER_GAP });
    };
    const follow = (event: Event): void => {
      if (!listRef.current?.contains(event.target as Node)) place();
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', follow, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', follow, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const focusTimer = window.setTimeout(() => optionRefs.current[selectedIndex]?.focus({ preventScroll: true }), 0);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open, selectedIndex]);

  const commit = (next: string): void => {
    if (value === undefined) setUncontrolled(next);
    if (next !== current) onChange?.({ target: { value: next }, currentTarget: { value: next } });
  };

  const choose = (option: ParsedOption): void => {
    if (option.disabled) return;
    commit(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const step = (from: number, direction: 1 | -1): number | undefined => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return undefined;
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.altKey || !options.length) { setOpen(true); return; }
      // Like a native select: arrows change the value without opening the list.
      const next = step(selectedIndex, event.key === 'ArrowDown' ? 1 : -1);
      if (next !== undefined) commit(options[next]!.value);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = step(index, 1);
    else if (event.key === 'ArrowUp') next = step(index, -1);
    else if (event.key === 'Home') next = enabledIndexes[0];
    else if (event.key === 'End') next = enabledIndexes.at(-1);
    else if (event.key === 'Tab') { setOpen(false); return; }
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Type-ahead: jump to the next option starting with that letter.
      const letter = event.key.toLowerCase();
      next = enabledIndexes.find((candidate) => candidate > index && options[candidate]!.label.toLowerCase().startsWith(letter))
        ?? enabledIndexes.find((candidate) => options[candidate]!.label.toLowerCase().startsWith(letter));
    } else return;
    event.preventDefault();
    if (next !== undefined) optionRefs.current[next]?.focus();
  };

  return (
    <>
      <UiButton
        ref={triggerRef}
        id={id}
        type="button"
        className={`kai-select ${open ? 'open' : ''} ${className}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        data-value={current}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((isOpen) => !isOpen)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="kai-select-value">{selected?.label ?? current}</span>
        <ChevronDown className="kai-select-chevron" size={14} aria-hidden="true" />
      </UiButton>
      {name && <input type="hidden" name={name} value={current} />}
      {open && createPortal(
        <div ref={listRef} className="kai-select-list" role="listbox" aria-label={ariaLabel} style={position}>
          {options.map((option, index) => (
            <UiButton
              ref={(element) => { optionRefs.current[index] = element; }}
              key={`${option.value}-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === current}
              data-value={option.value}
              className={`kai-select-option ${option.value === current ? 'selected' : ''}`.trim()}
              disabled={option.disabled}
              onClick={() => choose(option)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === current && <Check size={14} aria-hidden="true" />}
            </UiButton>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
