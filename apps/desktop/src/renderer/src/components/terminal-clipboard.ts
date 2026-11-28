/**
 * Copy and paste in the terminal, the way Windows Terminal and VS Code behave. Without this every Ctrl+C went to the
 * shell, so selected text could not be copied and trying to copy interrupted whatever was running.
 */
export type TerminalKeyAction =
  /** Copy the selection; the shell is sent nothing. */
  | 'copy'
  /** Leave the key to the browser, which pastes into the terminal. */
  | 'paste'
  /** Do nothing at all. */
  | 'ignore'
  /** The terminal handles the key as usual, so Ctrl+C with nothing selected still interrupts. */
  | 'pass';

export function terminalKeyAction(
  event: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  hasSelection: boolean,
): TerminalKeyAction {
  if (event.type !== 'keydown' || event.altKey) return 'pass';
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (command && key === 'c') {
    if (hasSelection) return 'copy';
    // Ctrl+Shift+C only ever means copy: with nothing selected it must not stop a running command.
    return event.shiftKey || event.metaKey ? 'ignore' : 'pass';
  }
  if (command && key === 'insert') return hasSelection ? 'copy' : 'ignore';
  if (command && key === 'v') return 'paste';
  if (event.shiftKey && key === 'insert') return 'paste';
  return 'pass';
}
