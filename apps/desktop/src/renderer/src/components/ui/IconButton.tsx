import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { UiButton } from '../UiButton';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  /** An icon-only control has no text to name it, so the name is required. */
  'aria-label': string;
  icon: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  /** Draws the control as selected: the same tint a selected option gets. */
  active?: boolean;
};

/** A round, compact icon button: attach, pause, stop, send, a panel toggle. One size across the app. */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton({ icon, variant = 'quiet', active = false, className = '', ...props }, ref) {
  return (
    <UiButton
      ref={ref}
      type="button"
      variant={variant}
      className={`kai-icon-button !h-7 !min-h-7 !w-7 !min-w-7 !rounded-full !p-0 ${active ? '!bg-[var(--selection)] !text-[var(--text)]' : ''} ${className}`.trim()}
      title={props.title ?? props['aria-label']}
      {...props}
    >
      {icon}
    </UiButton>
  );
});
