import { Button } from 'flowbite-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
};

/** Flowbite button used by renderer screens. Legacy class names remain as layout hooks during migration. */
export const UiButton = forwardRef<HTMLButtonElement, Props>(function UiButton({ variant, className = '', ...props }, ref) {
  const resolved = variant ?? (/(?:^|\s)(?:primary-button|send-button)(?:\s|$)/.test(className)
    ? 'primary'
    : /(?:^|\s)(?:secondary-button|chip-button)(?:\s|$)/.test(className)
      ? 'secondary'
      : /(?:^|\s)(?:danger-button|stop-button)(?:\s|$)/.test(className)
        ? 'danger'
        : 'quiet');
  const color = resolved === 'primary' ? 'default' : resolved === 'secondary' ? 'alternative' : resolved === 'danger' ? 'red' : 'gray';
  return <Button ref={ref} color={color} size="xs" className={className} {...props} />;
});
