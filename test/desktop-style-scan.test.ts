import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyFacts, readClassList, readCss, readMarkup, readStyleFacts, styleConventionsOf, thingFor } from '../apps/desktop/src/main/style-scan';

describe('style scan: stylesheets', () => {
  it('reads corners, borders and shadows from button and card rules, and ignores other rules', () => {
    const facts = emptyFacts();
    readCss(facts, `
      /* buttons */
      .btn-primary { background: #123; border-radius: 8px; border: none; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
      .card { border-radius: 12px; border: 0; box-shadow: 0 4px 12px rgba(0,0,0,.08); }
      .page-title { font-size: 20px; }
      .btn-link:hover { color: red; }
      @media (max-width: 600px) { .card { padding: 4px; } }
    `);
    expect(facts.samples).toEqual({ buttons: 1, cards: 1 });
    expect(facts.buttons.radius).toEqual({ '8px': 1 });
    expect(facts.buttons.border).toEqual({ none: 1 });
    expect(facts.cards.shadow).toEqual({ shadow: 1 });
  });

  it('calls a 1px border a hairline and a thicker one by its width', () => {
    const facts = emptyFacts();
    readCss(facts, '.card { border: 1px solid #ddd; } .card-wide { border: 2px solid #000; } .btn { border-width: 0.5px; border-radius: 9999px; }');
    expect(facts.cards.border).toEqual({ hairline: 1, '2px': 1 });
    expect(facts.buttons.border).toEqual({ hairline: 1 });
    expect(facts.buttons.radius).toEqual({ pill: 1 });
  });

  it('knows a button from a card by name, and a word that only contains the letters from neither', () => {
    expect(thingFor('.btn-primary')).toBe('buttons');
    expect(thingFor('button.save')).toBe('buttons');
    expect(thingFor('.card-body')).toBeNull();
    expect(thingFor('.card-title')).toBeNull();
    expect(thingFor('.btn-icon')).toBeNull();
    expect(thingFor('.button-group')).toBeNull();
    expect(thingFor('.discard-pile')).toBeNull();
    expect(thingFor('.cardigan')).toBeNull();
  });
});

describe('style scan: markup', () => {
  it('reads utility classes on buttons and cards', () => {
    const facts = emptyFacts();
    readMarkup(facts, `
      <button className="rounded-lg px-4 py-2 shadow-sm bg-black text-white">Save</button>
      <div class="card rounded-xl shadow-md p-4">x</div>
      <div className="card rounded-xl border p-4">y</div>
      <span className="text-sm">not either</span>
    `);
    expect(facts.samples).toEqual({ buttons: 1, cards: 2 });
    expect(facts.buttons.radius).toEqual({ lg: 1 });
    expect(facts.cards.border).toEqual({ hairline: 1 });
  });

  it('does not count a bare button twice when its class also names a button', () => {
    const facts = emptyFacts();
    readMarkup(facts, '<button class="btn rounded-md">Go</button>');
    expect(facts.samples.buttons).toBe(1);
  });

  it('does not infer any facets from a class list without shape utilities', () => {
    const facts = emptyFacts();
    readClassList(facts, 'cards', ['card', 'p-4']);
    expect(facts.cards).toEqual({ radius: {}, border: {}, shadow: {} });
    expect(facts.samples.cards).toBe(0);
  });

  it('resolves stylesheet variables and skips values it cannot resolve', () => {
    const facts = emptyFacts();
    readCss(facts, ':root { --round: 9999px; --line: 1px solid #ddd; --unknown: var(--missing); } .btn { border-radius: var(--round); border: var(--line); box-shadow: var(--unknown); }');
    expect(facts.buttons.radius).toEqual({ pill: 1 });
    expect(facts.buttons.border).toEqual({ hairline: 1 });
    expect(facts.buttons.shadow).toEqual({});
  });

  it('counts a stylesheet class once instead of counting its utility markup again', () => {
    const facts = emptyFacts();
    const styledClasses = new Set<string>();
    readCss(facts, '.btn { border-radius: 12px; }', styledClasses);
    readMarkup(facts, '<button className="btn rounded-lg border shadow-md">Save</button>', styledClasses);
    expect(facts.samples.buttons).toBe(1);
    expect(facts.buttons.radius).toEqual({ '12px': 1 });
    expect(facts.buttons.border).toEqual({});
    expect(facts.buttons.shadow).toEqual({});
  });
});

describe('style conventions', () => {
  it('reports only what a clear majority agrees on, with the counts behind it', () => {
    const facts = emptyFacts();
    for (let index = 0; index < 5; index += 1) readClassList(facts, 'cards', ['card', 'rounded-xl', 'shadow-md']);
    readClassList(facts, 'cards', ['card', 'rounded-none', 'border']);
    const [cards] = styleConventionsOf(facts);
    expect(cards?.text).toBe('Cards use rounded corners (xl), a soft shadow');
    expect(cards?.evidence).toContain('6 read');
    expect(cards?.evidence).toContain('5 of 6');
  });

  it('says nothing from too few samples, or from a split with no majority', () => {
    const few = emptyFacts();
    readClassList(few, 'cards', ['card', 'rounded-xl']);
    expect(styleConventionsOf(few)).toEqual([]);
    const split = emptyFacts();
    readClassList(split, 'cards', ['card', 'rounded-xl']);
    readClassList(split, 'cards', ['card', 'rounded-md']);
    readClassList(split, 'cards', ['card', 'rounded-sm']);
    expect(styleConventionsOf(split).find((item) => item.key === 'cards')?.text ?? '').not.toContain('rounded corners');
  });

  it('names the dislike of hairlines only when the whole project avoids them, and never when it uses one', () => {
    const clean = emptyFacts();
    for (let index = 0; index < 4; index += 1) readClassList(clean, 'cards', ['card', 'rounded-xl', 'border-none']);
    for (let index = 0; index < 3; index += 1) readClassList(clean, 'buttons', ['btn', 'rounded-lg', 'border-none']);
    expect(styleConventionsOf(clean).some((item) => item.key === 'no-hairlines')).toBe(true);

    const mixed = emptyFacts();
    for (let index = 0; index < 4; index += 1) readClassList(mixed, 'cards', ['card', 'rounded-xl']);
    for (let index = 0; index < 3; index += 1) readClassList(mixed, 'buttons', ['btn', 'border']);
    expect(styleConventionsOf(mixed).some((item) => item.key === 'no-hairlines')).toBe(false);
  });
});

describe('style scan: a folder', () => {
  it('reads stylesheets and markup in a project and skips node_modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-style-'));
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules', 'lib'), { recursive: true });
      await fs.writeFile(path.join(root, 'src', 'app.css'), '.card { border-radius: 12px; border: none; box-shadow: 0 2px 8px #0001; }');
      await fs.writeFile(path.join(root, 'src', 'Page.tsx'), '<div className="card rounded-xl shadow-md">x</div>');
      await fs.writeFile(path.join(root, 'node_modules', 'lib', 'bad.css'), '.card { border: 1px solid red; }');
      const facts = await readStyleFacts(root);
      expect(facts.samples.cards).toBe(1);
      expect(facts.cards.border['hairline']).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('reads more than the former 120-file cap and reports bounded scan metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-style-many-'));
    try {
      for (let index = 0; index < 125; index += 1) {
        await fs.writeFile(path.join(root, `part-${index}.css`), `.card-${index} { border-radius: 8px; }`);
      }
      const facts = await readStyleFacts(root);
      expect(facts.samples.cards).toBe(125);
      expect(facts.limits).toMatchObject({ filesRead: 125, fileLimited: false, byteLimited: 0 });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
