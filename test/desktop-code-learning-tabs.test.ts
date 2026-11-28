import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CodeLearningTabs, restoredCodeLearningTab } from '../apps/desktop/src/renderer/src/components/CodeLearningTabs';

describe('Learn & Code navigation', () => {
 it('restores learning after the removed Lead selection without changing saved progress', () => {
   expect(restoredCodeLearningTab('lead')).toBe('learn');
   expect(restoredCodeLearningTab(null)).toBe('learn');
   expect(restoredCodeLearningTab('guide')).toBe('guide');
   expect(restoredCodeLearningTab('review')).toBe('review');
 });
 it('offers Learn, Review and Guided Build without a development Lead tab', () => {
   const html = renderToStaticMarkup(React.createElement(CodeLearningTabs, { value: 'guide', onChange: vi.fn() }));
   expect(html).toContain('>Learn</button>');
   expect(html).toContain('>Review</button>');
   expect(html).toContain('>Guided Build</button>');
   expect(html).not.toContain('>Lead</button>');
   expect(html).toMatch(/aria-selected="true"[^>]*>Guided Build/);
 });
});
