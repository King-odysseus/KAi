import { describe, expect, it } from 'vitest';
import { savedTaskIntent } from '../apps/desktop/src/renderer/src/components/personas';

/**
 * The composer's intent is remembered, because the screen is unmounted whenever somebody looks at another one. Before
 * this, picking Auto and glancing at the Studio came back to the default — the app appearing to forget what it was told.
 *
 * What is worth pinning is the reading of storage, which outlives the code that wrote it.
 */
describe('remembering the composer intent', () => {
  it('restores the intent that was chosen', () => {
    expect(savedTaskIntent('auto')).toBe('auto');
    expect(savedTaskIntent('build')).toBe('build');
    expect(savedTaskIntent('equalizer')).toBe('equalizer');
    expect(savedTaskIntent('test')).toBe('test');
    expect(savedTaskIntent('audit')).toBe('audit');
    expect(savedTaskIntent('operate')).toBe('operate');
  });

  it('takes the old security-auditor id as Audit, because storage outlives the rename', () => {
    expect(savedTaskIntent('security-auditor')).toBe('audit');
  });

  it('falls back to General for nothing, or for something it no longer offers', () => {
    // An intent renamed or removed since it was stored must not leave the composer on a mode that does not exist.
    expect(savedTaskIntent(null)).toBe('ask');
    expect(savedTaskIntent('')).toBe('ask');
    expect(savedTaskIntent('autopilot')).toBe('ask');
    expect(savedTaskIntent('{"intent":"auto"}')).toBe('ask');
  });
});
