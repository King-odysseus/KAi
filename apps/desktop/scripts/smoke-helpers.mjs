/**
 * Waits until an async check run in the page returns something truthy, and returns it. Use this instead of
 * page.waitForFunction for anything that awaits (an IPC call): waitForFunction treats the pending promise itself
 * as truthy and returns at once, so the check never really runs.
 */
export async function waitForPage(page, check, arg, { timeoutMs = 15_000, intervalMs = 250, message = 'The page never reached the expected state.' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await page.evaluate(check, arg);
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`${message} (last result: ${JSON.stringify(last)})`);
    await page.waitForTimeout(intervalMs);
  }
}
