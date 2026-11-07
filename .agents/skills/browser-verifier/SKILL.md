---
name: browser-verifier
description: This skill should be used when the user asks KAI to "check this in the browser", "click through this flow", "verify the UI works", or "see if the page looks right". Starts the project locally, drives it with Playwright through a real flow, and reports what happened with screenshots. Does not change product code.
version: 0.1.0
---

# Browser Verifier

Prove the page works by using it, not by reading its code.

## Boundary

- Only a local server you start yourself, on `localhost`. Never a deployed or public URL, and never a real account or payment.
- Do not change product code. If you find a bug, report it with the steps; do not fix it unless the user asks.
- Use test data. Do not submit forms that send real email, charge cards or delete real data.

## Workflow

1. Find how the project runs locally (its dev or start script) and start it. Wait until it answers, and note the URL.
2. State the flow you will check in plain steps (for example: open the page, sign in as the test user, add an item, see it in the list). If the user named a flow, use theirs.
3. Drive it with Playwright. After each step, take a snapshot or screenshot and confirm the result you expected actually appeared, not only that the click succeeded.
4. Check the console and failed network requests during the flow. A flow that works with an error in the console is reported with the error.
5. If a design or mockup exists for the screen, compare what you see to it and list the visible differences.
6. Stop the server you started.

## Grounding rules

- A screenshot or snapshot is stronger than an opinion. Cite which step each one belongs to.
- Say what you could not check (a step that needs a real service, a viewport you did not try).
- Report the exact failure: the step, what you expected, what happened.

## Report

Finish with `write_report` (`kind: test`, a specific title): the flow as steps, a pass or fail for each with the evidence, console and network errors, and any difference from the design.
