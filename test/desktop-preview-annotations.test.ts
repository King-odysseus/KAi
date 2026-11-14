import { describe, expect, it } from 'vitest';
import { normalizePreviewAnnotationRect, previewAnnotationPrompt } from '../apps/desktop/src/renderer/src/preview-annotations';

describe('visual preview annotations', () => {
  it('accepts an in-viewport rectangle and rejects malformed or oversized bounds', () => {
    expect(normalizePreviewAnnotationRect({ x: 12, y: 18, width: 140, height: 90, viewportWidth: 800, viewportHeight: 600 })).toEqual({ x: 12, y: 18, width: 140, height: 90, viewportWidth: 800, viewportHeight: 600 });
    expect(normalizePreviewAnnotationRect({ x: 12, y: 18, width: 140, height: 90, viewportWidth: 100, viewportHeight: 600 })).toBeNull();
    expect(normalizePreviewAnnotationRect({ x: 0, y: 0, width: 0, height: 1_000_000, viewportWidth: 1_000_000, viewportHeight: 1_000_000 })).toBeNull();
  });

  it('hands marked coordinates and browser errors to the agent with the user request', () => {
    const prompt = previewAnnotationPrompt({
      selector: '', tagName: 'area', text: '', html: '', url: 'http://127.0.0.1:4173/',
      annotation: { x: 20, y: 35, width: 210, height: 120, viewportWidth: 800, viewportHeight: 600 },
    }, 'Move this card lower', [{ level: 'error', message: 'missing icon', source: 'app.js', line: 4 }]);
    expect(prompt).toContain('Annotated viewport area: x=20, y=35, width=210, height=120');
    expect(prompt).toContain('Move this card lower');
    expect(prompt).toContain('error: missing icon (app.js:4)');
  });
});
