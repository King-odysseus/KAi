// Shared layout guards for the smoke tests. Controls (buttons, selects, field labels, badges, tabs) keep their
// text on one line; only prose (hints, descriptions, textareas) may wrap. A layout that runs out of room should
// truncate with an ellipsis or reflow into another row, never break a label into two lines.

const CONTROL_SELECTOR = [
  'button',
  'select',
  'summary',
  'legend',
  'label > span',
  '[role="tab"]',
  '[role="option"]',
  '.status-pill',
  '.workflow-status',
  '.workflow-verdict',
  '.team-billing',
  '.team-access',
  '.nav-group-label',
].join(', ');

/** Controls whose own text breaks across more than one line, with enough detail to find them. */
export async function findWrappedControls(page) {
  return page.evaluate((selector) => {
    const offenders = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement) || seen.has(element)) continue;
      seen.add(element);
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      // A label that holds a title plus a hint (strong + small) is two lines by design.
      if (element.matches('label > span') && element.querySelector('small, strong, p, div, br')) continue;

      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const spans = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        // Descriptions inside a control are prose and may wrap.
        if (node.parentElement?.closest('small, p, pre, code, textarea')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0 && rect.height > 0) spans.push([rect.top, rect.bottom]);
        }
      }
      // Text of different sizes side by side (a label and a small badge) overlaps vertically and is one line;
      // wrapped text stacks, so each line starts below where the previous one ended.
      spans.sort((left, right) => left[0] - right[0]);
      let lineCount = 0;
      let lineBottom = Number.NEGATIVE_INFINITY;
      for (const [top, bottom] of spans) {
        if (top >= lineBottom - 2) lineCount += 1;
        lineBottom = Math.max(lineBottom, bottom);
      }
      if (lineCount > 1) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          className: String(element.className).slice(0, 70),
          label: element.getAttribute('aria-label') ?? '',
          text: (element.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
          lines: lineCount,
          width: Math.round(box.width),
        });
      }
    }
    return offenders;
  }, CONTROL_SELECTOR);
}

/** Throws when any control wraps. Set KAI_WRAP_REPORT=1 to list offenders without failing (used to audit). */
export async function assertControlsDoNotWrap(page, where) {
  const offenders = await findWrappedControls(page);
  if (offenders.length === 0) return;
  const detail = offenders.map((item) => `  - ${where}: <${item.tag}${item.className ? ` class="${item.className}"` : ''}> "${item.text}" wraps to ${item.lines} lines at ${item.width}px`).join('\n');
  if (process.env.KAI_WRAP_REPORT === '1') {
    console.log(`Wrapped controls on ${where}:\n${detail}`);
    return;
  }
  throw new Error(`Controls must not wrap their text (${where}):\n${detail}`);
}

/**
 * Throws when a toggle row (a label, a hint and a switch) is much taller than its text needs: a sign that a flex
 * rule meant for a row stretched it in a column.
 */
export async function assertTogglesCompact(page, where) {
  const tall = await page.evaluate(() => [...document.querySelectorAll('.toggle-row')].flatMap((row) => {
    const box = row.getBoundingClientRect();
    if (box.height === 0) return [];
    const content = [...row.children].reduce((most, child) => Math.max(most, child.getBoundingClientRect().height), 0);
    const text = [...row.querySelectorAll('strong, small')].reduce((total, item) => total + item.getBoundingClientRect().height, 0);
    return box.height > Math.max(content, text) + 60 ? [`"${(row.textContent ?? '').trim().slice(0, 50)}" is ${Math.round(box.height)}px tall`] : [];
  }));
  if (tall.length > 0) throw new Error(`Toggle rows are stretched (${where}): ${tall.join('; ')}`);
}
