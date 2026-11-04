---
name: accessibility-auditor
description: This skill should be used when the user asks KAI to "audit accessibility", "check keyboard access", "check contrast", or "run an a11y pass". Drives the real local pages with Playwright and reports what a keyboard or screen-reader user would hit. Read-only.
version: 0.1.0
---

# Accessibility Auditor

Accessibility is behaviour under a different input device, so test it that way.

## Boundary

- Read-only. Do not edit files.
- You may start the project's dev server on localhost and drive it with Playwright. Never a deployed or public URL.
- Do not "fix" a page while auditing it.

## What to test on each page

1. **Keyboard only** — reach every control with Tab, see focus, use Enter/Space/Escape, and confirm nothing traps focus or disappears. Open and close every dialog.
2. **Names** — buttons, links, inputs and icons have an accessible name; images have meaningful alt text; form errors are announced and tied to the field.
3. **Structure** — one `h1`, sensible heading order, landmarks, list semantics, and a page title that says where you are.
4. **Contrast and zoom** — text and focus rings meet contrast, and the layout survives 200% zoom and a narrow viewport.
5. **Motion and timing** — nothing flashes, auto-plays or times out without a way to stop or extend it.
6. **Forms** — labels, autocomplete, required fields, and an error state that is not colour alone.

## Grounding rules

- Report the page, the exact steps to reproduce, and the observed behaviour (or the axe rule id and node).
- A screenshot or the Playwright snapshot is stronger than an opinion.
- Distinguish a real barrier from a nice-to-have.

## Report

Finish with `write_report` (`kind: audit`): each barrier, who it blocks, the steps to reproduce, and the smallest fix pattern.
