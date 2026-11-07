import type { MouseEvent, ReactNode } from 'react';

/**
 * The one on/off switch: a `role="switch"` button on the theme's accent (styles in controls.css).
 *
 * It is not Flowbite's ToggleSwitch on purpose. That component renders a hidden checkbox ahead of its button, so a
 * wrapping `<label>` binds to the hidden input: the visible switch ends up with no name for a screen reader or a test,
 * and clicking the row's text toggles nothing. A plain button is the first control in its label, so the label names it
 * and a click anywhere on the row flips it.
 */
export function Toggle({ checked, onChange, label, disabled = false, size = 'md', title, ariaLabel, id, onClick }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Text shown beside the switch. Leave it out inside a `<label>` that already carries the text. */
  label?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  /** The switch's accessible name when no label text sits beside or around it. */
  ariaLabel?: string;
  id?: string;
  /** Lets a row that opens on click ignore a click that was only meant for the switch. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}): ReactNode {
  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`kai-switch-control ${size}`}
      onClick={() => onChange(!checked)}
    >
      <span className="kai-switch-thumb" aria-hidden="true" />
    </button>
  );
  if (label === undefined) return <span className="kai-switch" title={title} onClick={onClick}>{control}</span>;
  return <label className="kai-switch with-label" title={title} onClick={onClick}>{control}<span className="kai-switch-label">{label}</span></label>;
}
