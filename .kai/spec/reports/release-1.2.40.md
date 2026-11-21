# KAI 1.2.40

## Fixes

- When a step is built with a model picked from the "With..." menu, the card now shows and sends the model saved in Settings (for example `gateway/coding`) instead of "Gateway · Gateway". The same label rule applies everywhere: the provider's name is never shown twice.
- "Add an idea to the plan" works. Clicking it opens an input inside the card; submitting sends the idea to the Coach to fit into the plan. In Learn & Code it works the same way.
- Updating a plan no longer sends you back to step 1. Finished steps stay finished, a step you already approved is not asked about again, and the current step is the first one still to do.
- Notice banners keep a readable width: when their buttons would squeeze the text, the buttons drop to the next line.

## Version and use

- Desktop version: 1.2.40 (patch release; no breaking changes).
- Restart KAI after installing the updated desktop build.
- Roll back by installing the prior 1.2.39 build.

## Known

- Wrapped Windows notifications (toasts) were reported and are not fixed: KAI sends Windows a plain title and body and does not control how Windows wraps them. A screenshot of one would show whether it is a Windows pop-up or a banner inside KAI.
