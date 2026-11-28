import { describe, expect, it } from 'vitest';
import { terminalKeyAction } from '../apps/desktop/src/renderer/src/components/terminal-clipboard';

function key(value: string, modifiers: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; type: string }> = {}) {
  return { type: 'keydown', key: value, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers };
}

describe('terminal copy and paste keys', () => {
  it('copies a selection with Ctrl+C and still interrupts without one', () => {
    expect(terminalKeyAction(key('c', { ctrlKey: true }), true)).toBe('copy');
    expect(terminalKeyAction(key('c', { ctrlKey: true }), false)).toBe('pass');
  });

  it('never interrupts on Ctrl+Shift+C', () => {
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), true)).toBe('copy');
    expect(terminalKeyAction(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('ignore');
  });

  it('pastes with the usual keys', () => {
    expect(terminalKeyAction(key('v', { ctrlKey: true }), false)).toBe('paste');
    expect(terminalKeyAction(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(terminalKeyAction(key('Insert', { shiftKey: true }), false)).toBe('paste');
    expect(terminalKeyAction(key('Insert', { ctrlKey: true }), true)).toBe('copy');
  });

  it('leaves every other key, and AltGr combinations, to the shell', () => {
    expect(terminalKeyAction(key('d', { ctrlKey: true }), true)).toBe('pass');
    expect(terminalKeyAction(key('v', { ctrlKey: true, altKey: true }), false)).toBe('pass');
    expect(terminalKeyAction(key('c', { ctrlKey: true, type: 'keyup' }), true)).toBe('pass');
    expect(terminalKeyAction(key('c'), true)).toBe('pass');
  });
});
