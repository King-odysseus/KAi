import { describe, expect, it } from 'vitest';
import { quoteWinArg } from '../src/adapters/process-runner';

describe('quoteWinArg', () => {
  it('leaves simple single-token args unquoted', () => {
    expect(quoteWinArg('claude')).toBe('claude');
    expect(quoteWinArg('--output-format')).toBe('--output-format');
    expect(quoteWinArg('stream-json')).toBe('stream-json');
  });

  it('quotes multi-word prompts so they stay one argument', () => {
    expect(quoteWinArg('tell me about this project')).toBe('"tell me about this project"');
  });

  it('quotes args with shell metacharacters', () => {
    expect(quoteWinArg('a & b')).toBe('"a & b"');
    expect(quoteWinArg('x | y')).toBe('"x | y"');
  });

  it('escapes embedded double quotes', () => {
    expect(quoteWinArg('say "hi" now')).toBe('"say ""hi"" now"');
  });

  it('quotes an empty string', () => {
    expect(quoteWinArg('')).toBe('""');
  });
});
