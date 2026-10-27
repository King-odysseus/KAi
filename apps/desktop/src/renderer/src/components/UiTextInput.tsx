import { TextInput } from 'flowbite-react';
import { forwardRef, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'color'>;

/** Flowbite input that keeps existing input selectors and compact renderer layout working. */
export const UiTextInput = forwardRef<HTMLInputElement, Props>(function UiTextInput({ className = '', ...props }, ref) {
  return <TextInput ref={ref} sizing="md" className="contents" theme={{ field: { base: 'contents', input: { base: className } } }} {...props} />;
});
