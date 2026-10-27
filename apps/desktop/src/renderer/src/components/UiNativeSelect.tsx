import { Select } from 'flowbite-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'color'>;

/** Native select behavior with Flowbite's styling and KAi's compact layout. */
export const UiNativeSelect = forwardRef<HTMLSelectElement, Props>(function UiNativeSelect({ className = '', ...props }, ref) {
  return <Select ref={ref} sizing="md" className="contents" theme={{ field: { base: 'contents', select: { base: className } } }} {...props} />;
});
