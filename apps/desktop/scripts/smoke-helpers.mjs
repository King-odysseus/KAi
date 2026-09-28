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

/** Picks an option in KAI's dropdown (components/ui/Select.tsx) by its value, as selectOption did for a native select. */
export async function chooseOption(select, value) {
  await select.click();
  await select.page().locator(`.kai-select-list [role="option"][data-value="${value}"]`).click();
}

/** The value a KAI dropdown currently shows, as inputValue() gave for a native select. */
export async function selectedValue(select) {
  return select.getAttribute('data-value');
}

/** The labels a KAI dropdown offers. The list only exists while open, so this opens it and closes it again. */
export async function optionLabels(select) {
  await select.click();
  const options = select.page().locator('.kai-select-list [role="option"]');
  await options.first().waitFor();
  const labels = await options.allTextContents();
  await select.page().keyboard.press('Escape');
  return labels.map((label) => label.trim());
}
