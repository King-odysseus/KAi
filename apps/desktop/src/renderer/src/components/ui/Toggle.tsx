import { ToggleSwitch } from 'flowbite-react';
import type { ReactNode } from 'react';

/** The one on/off switch, a Flowbite ToggleSwitch on the theme's accent. */
export function Toggle({ checked, onChange, label, disabled = false, size = 'sm', title }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
}): ReactNode {
  return (
    <span title={title} className="inline-flex">
      <ToggleSwitch checked={checked} onChange={onChange} label={typeof label === 'string' ? label : undefined} disabled={disabled} sizing={size} />
      {typeof label !== 'string' && label}
    </span>
  );
}
