import { Modal } from 'flowbite-react';
import { useEffect, type ComponentProps } from 'react';

/**
 * Names a Flowbite dialog after its own heading.
 *
 * Flowbite's Modal sets `aria-labelledby` on the dialog from the id of its own `ModalHeader`, and writes `undefined` over
 * any value passed in when there is no such header. All of KAI's dialogs draw their own heading, so each one reached
 * a screen reader (and a test looking for `role=dialog` by name) with no name at all. This points the dialog at the
 * heading with the given id as soon as the dialog is in the page.
 */
function useDialogName(titleId: string): void {
  useEffect(() => {
    const apply = (): boolean => {
      const dialog = document.getElementById(titleId)?.closest('[role="dialog"]');
      if (!dialog) return false;
      if (dialog.getAttribute('aria-labelledby') !== titleId) dialog.setAttribute('aria-labelledby', titleId);
      return true;
    };
    if (apply()) return undefined;
    // The dialog is portalled in a moment after this component mounts, so wait for it.
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [titleId]);
}

/** A Flowbite Modal whose dialog is named by the heading with id `titleId`. Always shown: mount it only while open. */
export function Dialog({ titleId, ...props }: Omit<ComponentProps<typeof Modal>, 'show' | 'aria-labelledby'> & { titleId: string }) {
  useDialogName(titleId);
  return <Modal show {...props} aria-labelledby={titleId} />;
}
