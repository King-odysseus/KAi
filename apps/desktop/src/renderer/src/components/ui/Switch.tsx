import type { MouseEvent, ReactNode } from 'react';
import { Toggle } from './Toggle';

/**
 * An on/off setting drawn as a switch, with the same props as the checkbox it replaces, so a settings row changes
 * from `<Checkbox checked onChange={(event) => … event.target.checked}>` to `<Switch …>` and nothing else.
 * It is for a setting that is either on or off. Picking items out of a list is still a checkbox.
 *
 * Inside a `<label>` the whole row toggles it and the label text names it, exactly as it did for the checkbox.
 */
export function Switch({ checked, onChange, disabled = false, id, title, 'aria-label': ariaLabel, onClick }: {
  checked: boolean;
  onChange: (event: { target: { checked: boolean } }) => void;
  disabled?: boolean;
  id?: string;
  title?: string;
  'aria-label'?: string;
  /** Lets a row that opens on click ignore a click that was only meant for the switch. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}): ReactNode {
  return <Toggle id={id} checked={checked} disabled={disabled} title={title} ariaLabel={ariaLabel} onClick={onClick} onChange={(next) => onChange({ target: { checked: next } })} />;
}
