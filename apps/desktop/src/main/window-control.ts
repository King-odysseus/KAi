/**
 * Lets an agent look at and operate KAI's own windows, and nothing else on the machine.
 *
 * It works through each window's page (a capture of that page, the elements on it, input sent to it), so it cannot
 * see another application, a password manager or the desktop behind KAI. Reading is always available; anything that
 * changes the page goes through the MCP runtime's usual rules, so it is asked about unless the run has full access.
 *
 * One thing is walled off whatever the run's access: while KAI is asking the person to approve something, the agent
 * cannot touch the window. Otherwise a run could press "Allow" on its own request, or on another conversation's.
 */

export interface ControlledWebContents {
  capturePage(): Promise<{ toPNG(): Buffer; getSize(): { width: number; height: number }; resize(options: { width: number }): { toPNG(): Buffer } }>;
  executeJavaScript(code: string): Promise<unknown>;
  sendInputEvent(event: Record<string, unknown>): void;
  insertText(text: string): Promise<void>;
}

export interface ControlledWindow {
  id: number;
  title: string;
  projectId: string | null;
  focused: boolean;
  webContents: ControlledWebContents;
}

export interface WindowElement {
  ref: string;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface WindowSnapshot {
  title: string;
  view: string;
  width: number;
  height: number;
  approvalOpen: boolean;
  elements: WindowElement[];
}

const MAX_SHOT_WIDTH = 1280;

/** Runs in the page. Marks each visible control with a short reference the agent can name in a click. */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [role="link"], [contenteditable="true"]';
  for (const old of document.querySelectorAll('[data-kai-ref]')) old.removeAttribute('data-kai-ref');
  const elements = [];
  let counter = 0;
  for (const node of document.querySelectorAll(selector)) {
    if (elements.length >= 250) break;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const ref = 'e' + (++counter);
    node.setAttribute('data-kai-ref', ref);
    const name = (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.getAttribute('placeholder') || node.value || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
    const role = node.getAttribute('role') || (node.tagName === 'A' ? 'link' : node.tagName === 'INPUT' ? (node.type || 'text') + ' input' : node.tagName.toLowerCase());
    const entry = { ref, role, name, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    if ('value' in node && typeof node.value === 'string' && node.value && node.type !== 'password') entry.value = node.value.slice(0, 100);
    if (node.disabled) entry.disabled = true;
    if (typeof node.checked === 'boolean') entry.checked = node.checked;
    elements.push(entry);
  }
  const heading = document.querySelector('h1, h2, [aria-current="page"], .view-title');
  return {
    title: document.title,
    view: heading ? heading.innerText.trim().slice(0, 100) : '',
    width: innerWidth,
    height: innerHeight,
    approvalOpen: Boolean(document.querySelector('.approval-dialog')),
    elements,
  };
})()`;

const approvalOpenScript = "Boolean(document.querySelector('.approval-dialog'))";

function centerOfScript(ref: string): string {
  return `(() => {
    const node = document.querySelector('[data-kai-ref="' + ${JSON.stringify(ref)} + '"]');
    if (!node) return null;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), insideApproval: Boolean(node.closest('.approval-dialog')) };
  })()`;
}

const KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

export class WindowControl {
  constructor(private readonly windows: () => ControlledWindow[]) {}

  list(): Array<{ window_id: number; title: string; project_id: string | null; focused: boolean }> {
    return this.windows().map((window) => ({ window_id: window.id, title: window.title, project_id: window.projectId, focused: window.focused }));
  }

  private target(windowId?: number): ControlledWindow {
    const windows = this.windows();
    if (windows.length === 0) throw new Error('No KAI window is open.');
    if (windowId === undefined) return windows.find((window) => window.focused) ?? windows[0]!;
    const found = windows.find((window) => window.id === windowId);
    if (!found) throw new Error(`There is no KAI window ${windowId}. Call window_list for the open ones.`);
    return found;
  }

  /** A PNG of the window's page, narrowed to a width a model can read without spending a fortune on it. */
  async screenshot(windowId?: number): Promise<{ png: Buffer; windowId: number; width: number; height: number }> {
    const window = this.target(windowId);
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    const scaled = size.width > MAX_SHOT_WIDTH ? image.resize({ width: MAX_SHOT_WIDTH }) : image;
    return { png: scaled.toPNG(), windowId: window.id, width: Math.min(size.width, MAX_SHOT_WIDTH), height: size.width > MAX_SHOT_WIDTH ? Math.round(size.height * (MAX_SHOT_WIDTH / size.width)) : size.height };
  }

  async snapshot(windowId?: number): Promise<WindowSnapshot & { window_id: number }> {
    const window = this.target(windowId);
    const snapshot = await window.webContents.executeJavaScript(SNAPSHOT_SCRIPT) as WindowSnapshot;
    return { window_id: window.id, ...snapshot };
  }

  private async guardInput(window: ControlledWindow): Promise<void> {
    if (await window.webContents.executeJavaScript(approvalOpenScript) === true) {
      throw new Error('KAI is waiting for the person to answer an approval. Window input is paused until they do; ask them to respond, then continue.');
    }
  }

  async click(input: { windowId?: number; ref?: string; x?: number; y?: number; double?: boolean; right?: boolean }): Promise<string> {
    const window = this.target(input.windowId);
    await this.guardInput(window);
    let x = input.x;
    let y = input.y;
    if (input.ref) {
      const center = await window.webContents.executeJavaScript(centerOfScript(input.ref)) as { x: number; y: number; insideApproval: boolean } | null;
      if (!center) throw new Error(`No element ${input.ref} on the page. Call window_snapshot again; references change when the page does.`);
      if (center.insideApproval) throw new Error('That control belongs to an approval prompt, which only the person may answer.');
      x = center.x;
      y = center.y;
    }
    if (x === undefined || y === undefined) throw new Error('Give either a ref from window_snapshot or both x and y.');
    const button = input.right ? 'right' : 'left';
    const clickCount = input.double ? 2 : 1;
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    for (let count = 1; count <= clickCount; count += 1) {
      window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: count });
      window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: count });
    }
    return `Clicked ${input.ref ?? `${x},${y}`}.`;
  }

  async type(input: { windowId?: number; ref?: string; text: string; clear?: boolean }): Promise<string> {
    const window = this.target(input.windowId);
    await this.guardInput(window);
    if (input.ref) await this.click({ ...(input.windowId === undefined ? {} : { windowId: input.windowId }), ref: input.ref });
    if (input.clear) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    }
    await window.webContents.insertText(input.text);
    return `Typed ${input.text.length} characters.`;
  }

  async pressKey(input: { windowId?: number; key: string; modifiers?: Array<'shift' | 'control' | 'alt'> }): Promise<string> {
    const window = this.target(input.windowId);
    await this.guardInput(window);
    const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
    if (input.key.length !== 1 && !KEYS.has(input.key)) throw new Error(`Unknown key ${input.key}. Use a single character or one of: ${[...KEYS].join(', ')}.`);
    const modifiers = input.modifiers ?? [];
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    return `Pressed ${[...modifiers, input.key].join('+')}.`;
  }

  async scroll(input: { windowId?: number; x?: number; y?: number; deltaY: number }): Promise<string> {
    const window = this.target(input.windowId);
    await this.guardInput(window);
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: input.x ?? 400, y: input.y ?? 300, deltaX: 0, deltaY: -input.deltaY });
    return `Scrolled ${input.deltaY}.`;
  }
}

/** Tells an agent KAI's windows can be seen and operated, and what it is not: it cannot see anything outside KAI. */
export function windowBriefing(executionMode: 'cli' | 'api'): string {
  const tools = '`window_list`, `window_screenshot`, `window_snapshot`, `window_click`, `window_type`, `window_key`, `window_scroll`';
  return [
    '# KAI windows',
    `To check how a KAI screen looks or behaves, use ${executionMode === 'cli' ? 'the `kai-window` MCP server' : 'the `kai-window` tools'} (${tools}) instead of guessing from file names: take a screenshot, list the controls with \`window_snapshot\`, then click or type by ref. They reach KAI's own windows only, not other applications. Input pauses while the person has an approval to answer. If you cannot verify something, say so.`,
    ...(executionMode === 'cli' ? [
      '',
      '# Browser',
      'For any web page (a dev server, a preview, a deployed site), use the `playwright` MCP server: `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_resize`. It drives the one shared Chrome KAI runs, and it is already connected. If those tools are not listed up front they are deferred: find them with your tool search (query "playwright" or "browser_navigate") before concluding there is no browser. Do not look for a Playwright package in the project and do not use a built-in browser plugin or computer-use host; neither exists in a KAI run. Only report browser checking as unavailable after a `browser_tabs` call with action "list" has actually failed, and quote its error.',
    ] : []),
  ].join('\n');
}
