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
 * Text that runs past the box that hides it.
 *
 * The mirror image of the control check above: prose is meant to wrap, so when a line reaches the edge of a clipping
 * box the reader loses the end of the sentence. This walks every visible text node and measures it against the
 * nearest ancestor that hides its overflow. A box that scrolls is left alone, since the text is still reachable, and
 * so is an ellipsis, which at least admits that something is missing. `overhangBottom` marks text cut off at the
 * bottom of a fixed-height box, the same fault in the other direction.
 */
export async function findClippedText(page, { tolerance = 2 } = {}) {
  return page.evaluate((limit) => {
    const offenders = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const own = getComputedStyle(parent);
      if (own.display === 'none' || own.visibility === 'hidden' || Number.parseFloat(own.opacity || '1') === 0) continue;
      // A line-clamped summary is intentionally shortened; the clamp is the visible equivalent of an ellipsis.
      if (own.webkitLineClamp && own.webkitLineClamp !== 'none' && own.webkitLineClamp !== '0') continue;
      // Offscreen measurement layers and screen-reader copies are not what the reader sees.
      if (parent.closest('[aria-hidden="true"], .sr-only, .visually-hidden, [hidden]')) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      let clip = parent;
      let clipStyle = own;
      while (clip.parentElement && clipStyle.overflowX === 'visible') {
        clip = clip.parentElement;
        clipStyle = getComputedStyle(clip);
      }
      const scrollable = clipStyle.overflowX === 'auto' || clipStyle.overflowX === 'scroll';
      if (clip !== document.documentElement && !scrollable) {
        const box_ = clip.getBoundingClientRect();
        const left = box_.left + clip.clientLeft;
        const right = left + clip.clientWidth;
        const top = box_.top + clip.clientTop;
        const bottom = top + clip.clientHeight;
        // Content in a collapsed or translated-away panel is not visible text. Treat it like any other hidden UI,
        // otherwise a panel parked offscreen reports every descendant as clipped by hundreds of pixels.
        if (box.right <= left || box.left >= right || box.bottom <= top || box.top >= bottom) continue;
        const vertical = clipStyle.overflowY !== 'visible' && clipStyle.overflowY !== 'auto' && clipStyle.overflowY !== 'scroll';
        const overhang = Math.round(box.right - right);
        const overhangLeft = Math.round(left - box.left);
        const overhangBottom = vertical ? Math.round(box.bottom - bottom) : 0;
        if ((overhang <= limit && overhangLeft <= limit && overhangBottom <= limit) || own.textOverflow === 'ellipsis') continue;
        offenders.push({
          in: `${clip.tagName.toLowerCase()}${clip.className ? `.${String(clip.className).trim().split(/\s+/).join('.')}` : ''}`.slice(0, 90),
          tag: parent.tagName.toLowerCase(),
          className: String(parent.className).slice(0, 70),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          overflow: `${clipStyle.overflowX}/${clipStyle.overflowY}`,
          ellipsis: own.textOverflow === 'ellipsis',
          nowrap: own.whiteSpace === 'nowrap' || own.whiteSpace === 'pre',
          length: Math.round(box.width),
          overhang,
          overhangLeft,
          overhangBottom,
        });
        continue;
      }
      // Nothing hides it, so it only faults if it leaves the window.
      const viewport = document.documentElement.clientWidth;
      if (box.right > viewport + limit) {
        offenders.push({
          in: 'body',
          tag: parent.tagName.toLowerCase(),
          className: String(parent.className).slice(0, 70),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          overflow: 'visible',
          ellipsis: own.textOverflow === 'ellipsis',
          nowrap: own.whiteSpace === 'nowrap' || own.whiteSpace === 'pre',
          length: Math.round(box.width),
          overhang: Math.round(box.right - viewport),
          overhangLeft: 0,
          overhangBottom: 0,
        });
      }
    }
    // One entry per element, not per text node: a paragraph cut off at the edge is one fault, not twelve.
    const unique = new Map();
    for (const item of offenders) unique.set(`${item.tag}|${item.className}|${item.text}`, item);
    return [...unique.values()];
  }, tolerance);
}

/** Throws when prose is cut off by a box that hides it. Set KAI_WRAP_REPORT=1 to list offenders without failing. */
export async function assertTextIsNotClipped(page, where) {
  const offenders = await findClippedText(page);
  if (offenders.length === 0) return;
  const detail = offenders
    .map((item) => `  - <.${item.className || item.tag}> inside <${item.in}> "${item.text}" overhangs ${item.overhang}px right / ${item.overhangLeft}px left / ${item.overhangBottom}px bottom (${item.overflow}${item.nowrap ? ', nowrap' : ''}${item.ellipsis ? ', ellipsis' : ''}, ${item.length}px wide)`)
    .join('\n');
  if (process.env.KAI_WRAP_REPORT === '1') {
    console.log(`Clipped text on ${where}:\n${detail}`);
    return;
  }
  throw new Error(`Prose is being clipped instead of wrapping (${where}):\n${detail}`);
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
