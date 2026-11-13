# Live preview checks

Use the small fixture project in `apps/desktop/scripts/smoke-workbench.mjs` when checking the Live Preview pane. The
fixture starts a tiny local HTTP server, renders one page, and exposes a single selectable element. The harness checks
that the preview starts and stops, captures browser errors, sends an element selection to the composer, and exercises
the pane at desktop and minimum window sizes.

Run it from the repository root with:

```powershell
npm run desktop:smoke:workbench
```

Do not use the KAI repository itself as the preview fixture for routine visual checks. Its development server and
dependency graph are much larger than the behavior under test and can exhaust memory on a developer machine. To
check a real project, make a small fixture with a minimal start command and a page that exercises the specific UI in
question.
