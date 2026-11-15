import { describe, expect, it } from 'vitest';
import { routeMessage } from '../apps/desktop/src/renderer/src/crew-routing';

describe('working out what a message to the Lead means', () => {
  it('treats questions as questions, in any state', () => {
    for (const text of ['What is stopping Phase 1?', 'whats done so far', 'Why did it stop?', 'How much has it cost', 'Is the security review finished?', 'Explain the plan', 'tell me what is left']) {
      expect(routeMessage(text, true), text).toBe('ask');
      expect(routeMessage(text, false), text).toBe('ask');
    }
  });

  it('treats a plain instruction as more work on a finished crew, and a steer on one that is working', () => {
    for (const text of ['Start Phase 1', 'Build the shell and the login', 'Continue with the next phase', 'install it and run the tests']) {
      expect(routeMessage(text, true), text).toBe('work');
      expect(routeMessage(text, false), text).toBe('steer');
    }
  });

  it('does not let a polite wrapper turn a request into a question', () => {
    expect(routeMessage('Can you start Phase 1?', true)).toBe('work');
    expect(routeMessage('please add a dark mode', false)).toBe('steer');
    expect(routeMessage('Could you please fix the login bug?', true)).toBe('work');
    expect(routeMessage("I'd like you to skip the settings screen", false)).toBe('steer');
  });

  it('still treats a polite question as a question', () => {
    expect(routeMessage("can you tell me what's done?", true)).toBe('ask');
    expect(routeMessage('would the next phase need approval?', true)).toBe('ask');
  });

  it('treats a statement as a request, and an empty box as a question', () => {
    expect(routeMessage('The login must use the existing session', false)).toBe('steer');
    expect(routeMessage('   ', true)).toBe('ask');
  });
});
