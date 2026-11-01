import type { ReactNode } from 'react';
import { promptDialog } from './AppDialog';
import { Select } from './ui/Select';

/**
 * A pick-list that always shows every choice, in KAI's own dropdown. A text box with a suggestion list is the
 * browser's unstyled popup and shows only the entries that match what is already typed, so once a value was chosen
 * the list looked as if there were only that one. A name that is not in the list can still be entered through the
 * last entry.
 */
export function ModelField({
  label,
  value,
  models,
  emptyLabel,
  noun = 'model',
  disabled,
  error,
  labelClassName = 'field',
  onChange,
}: {
  label: string;
  value: string;
  models: readonly string[];
  /** Shown for the empty choice. Without it the field always holds a value. */
  emptyLabel?: string;
  /** What is being picked, for the "Custom …" entry and its dialog. */
  noun?: string;
  disabled?: boolean;
  /** A problem with the current value, shown under the field. */
  error?: string;
  labelClassName?: string;
  onChange: (value: string) => void;
}): ReactNode {
  const shown = value && !models.includes(value) ? [value, ...models] : models;
  return (
    <label className={labelClassName}>
      <span>{label}</span>
      <Select
        aria-label={label}
        aria-invalid={error ? true : undefined}
        disabled={disabled}
        value={value}
        onChange={(event) => {
          if (event.target.value !== '__custom__') {
            onChange(event.target.value);
            return;
          }
          void promptDialog({ title: `Custom ${noun}`, label: `Enter the ${noun}`, initialValue: value })
            .then((entered) => { if (entered?.trim()) onChange(entered.trim()); });
        }}
      >
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {shown.map((model) => <option key={model} value={model}>{model}</option>)}
        <option value="__custom__">Custom {noun}…</option>
      </Select>
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}
