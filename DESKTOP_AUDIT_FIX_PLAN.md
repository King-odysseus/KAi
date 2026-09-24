# KAI desktop audit: implementation plan

This is the implementation handoff from the desktop audit conversation. Findings describe the code and installed package inspected during that audit; recheck the current revision before making changes. This document does not claim that the fixes have been implemented.

## Scope and objective

Make the **standalone Electron desktop app** reliable across Learn mode, editing, workflows, service configuration, and independent project windows.

- Repository: `C:\Users\Mega-Mind\Documents\WebDev Projects\KAi`
- Target: `apps/desktop` and its shared packages.
- This is not a VS Code extension task.
- User-selected window behavior: **New Window**, with each window keeping its own selected project and conversation while sharing settings and credentials.

## Working rules

1. Inspect the working tree and applicable `AGENTS.md` instructions first.
2. Preserve existing changes. Learn preference persistence and Cognitive1 port fixes already exist in source; extend and verify them rather than replacing them.
3. Confirm each reported issue against current source before fixing it.
4. Implement the work rather than stopping at another audit.
5. Use isolated temporary projects and application data for automated tests. Ensure application startup does not modify real CLI configuration during tests.
6. Never print API keys, decrypt credentials for inspection, or overwrite real user configuration during tests.
7. Use local provider fixtures by default. Obtain authorization before chargeable provider tests.
8. Do not reinstall or restart the user's running app without explicit authorization.
9. Keep implementation phases separate and reviewable.
10. Report remaining limitations honestly.

The audit baseline passed desktop type-checking, the build, 522 automated tests, and both existing desktop smoke suites; one test was skipped. Those tests did not cover several reported failures. These are historical baseline results, not validation of future changes.

## Phase 1 — Learn mode state and request handling

### Primary files

- `apps/desktop/src/renderer/src/components/CodeView.tsx`
- `apps/desktop/src/renderer/src/components/LearningPanel.tsx`
- `apps/desktop/src/main/learning-progress.ts`
- `apps/desktop/src/main/learning-tutor.ts`
- `apps/desktop/src/main/ipc.ts`
- `packages/contracts/src/learning.ts`
- `test/desktop-learning.test.ts`
- `test/desktop-learning-preferences.test.ts`

### Problems

Learn selection can be overwritten by late preference-save responses, initial progress loads, or tutor responses. Tutor requests can finish after the user switches files or projects.

### Implementation

1. Separate selected assistance preferences from asynchronously returned learning progress.
2. Apply mode changes immediately in the UI.
3. Serialize persistence or use revisions so the latest selection wins in both the UI and storage.
4. Prevent outdated save failures from reverting a newer successful selection.
5. Preserve existing shared-preference behavior across projects and restarts.
6. Bind tutor requests to project ID, file path, document version, request ID, and relevant selection/range.
7. Ignore or explicitly mark responses that no longer match the active context.
8. Cancel obsolete requests where practical.
9. Never apply suggestions to another file or a silently changed selection.
10. Prevent overlapping tutor actions from corrupting busy/error state.

### Acceptance tests

- [ ] Rapidly select Learn → Pair → Copilot; Copilot remains selected regardless of response order.
- [ ] Select a mode while initial progress is loading.
- [ ] Change mode during a tutor request.
- [ ] Navigate away and back, switch projects, and restart; saved preferences remain.
- [ ] Switch files/projects during a delayed response; no stale result or insertion reaches the new document.
- [ ] Save failures provide clear feedback without reverting newer choices.

## Phase 2 — Protect editor work and replace browser prompts

### Primary files

- `apps/desktop/src/renderer/src/components/CodeView.tsx`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/components/Workspace.tsx`
- `apps/desktop/src/renderer/src/components/Pages.tsx`
- Main-process window lifecycle code.

### Unsaved document handling

The audited Code view disposes its models when unmounted or when projects change. Implement document/session ownership that survives ordinary page navigation. Add **Save / Discard / Cancel** handling when an operation would destroy dirty documents, including project switching and window closing.

- Cancel must leave the current context intact.
- Failed saves must prevent destructive navigation.
- Handle multiple dirty files clearly.
- Preserve external-change conflict checks, encoding, BOM, and line endings.
- Prevent an old project's asynchronous file response from attaching to a new project.

### Save race

A save marks a document clean even if the user types while the write is pending. Capture the saved snapshot/version and mark the document clean only if current contents still match after the write succeeds.

### Replace `window.prompt`

Replace all desktop renderer occurrences with accessible application dialogs. Known affected actions:

- New file.
- Explain error.
- Rename conversation.
- Add selection context: file path and line range.
- Search memory.
- Custom model entry.

Provide validation, visible errors, appropriate Enter/Escape behavior, and predictable focus restoration.

### Acceptance tests

- [ ] Edit a file, navigate to another page, return, and retain the edit.
- [ ] Project switching and closing prompt correctly.
- [ ] Save failure preserves the document and navigation state.
- [ ] Typing during a delayed save leaves newer text marked unsaved.
- [ ] Every replacement dialog performs its action and cancels without mutation.

## Phase 3 — Tutor configuration, context, and usage

### Primary files

- `apps/desktop/src/main/learning-tutor.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/usage-budget.ts`
- Learning/settings UI components and relevant contracts.

### Readiness

Learning uses Direct API configuration independently of CLI authentication. Expose structured readiness covering enabled status, supported provider/protocol, model configuration, credential availability, and actionable configuration errors.

Show readiness in the learning panel with a route to relevant settings. Do not make a billable request merely to render readiness. During the audit, settings showed DeepSeek enabled, but successful authenticated tutor execution was not verified.

### Large-file context

Repair `boundedCode()`. The audited implementation reconstructs substantial file content before slicing from the beginning, potentially excluding the active area.

Build a bounded excerpt around the selection/cursor. Preserve original line numbers, identify omitted content, and retain selected code within documented limits.

### Usage and budgets

Apply shared budget policy to tutor evaluation and teaching-draft generation.

- Record provider-reported usage when available.
- Distinguish estimates from measured costs.
- Handle missing usage honestly.
- Prevent blocked requests before sending them.
- Avoid double-counting retries or recorded lessons.
- Consider concurrent requests when enforcing limits.

Also verify structured-response schemas against supported provider protocols using fixtures. Treat any newly discovered protocol incompatibility as a verified finding rather than assuming it already exists.

### Acceptance tests

- [ ] Missing/unsupported configuration produces useful guidance.
- [ ] A selection near the end of a large file reaches the provider fixture.
- [ ] Blocked budgets prevent outbound calls.
- [ ] Successful tutor calls appear in usage reporting.
- [ ] Timeouts, malformed responses, and provider errors recover the UI cleanly.

## Phase 4 — Managed Cognitive1 isolation

### Primary files

- `apps/desktop/src/main/service-controller.ts`
- `packages/contracts/src/domain.ts`
- `test/desktop-service-controller.test.ts`

### Reported error

```text
listen EADDRINUSE: address already in use 127.0.0.1:9876
```

This means the service tried to listen on an occupied address/port. The error alone does not identify the owning process. Identify whether it is a standalone Cognitive1 daemon, another managed instance, or another application before deciding how to recover.

Existing source contains work to keep managed Cognitive1 separate from the standalone daemon on port `9876`. Verify and complete it:

1. Inspect the migration and preserve intentional user endpoints.
2. Ensure managed startup uses the migrated endpoint consistently.
3. Verify authentication/token handling after migration.
4. Handle occupied ports and startup failures with clear diagnostics.
5. Prevent KAI from stopping or restarting an unrelated standalone daemon.
6. Verify settings remain consistent after restart.
7. Confirm the installed build actually contains the migration.

Test Brain, Tasks, Coordination, and Diagnostics downstream behavior using fixtures where possible. Do not assume all downstream failures share one cause.

### Acceptance tests

- [ ] Standalone and KAI-managed services coexist.
- [ ] Legacy settings migrate appropriately.
- [ ] Migration is idempotent.
- [ ] Startup failures explain the cause and recovery action.
- [ ] No unrelated process is terminated.

## Phase 5 — Main-process workflow execution

### Primary files

- `apps/desktop/src/renderer/src/components/Pages.tsx`
- `apps/desktop/src/main/workflow-templates.ts`
- `apps/desktop/src/main/ipc.ts`
- Runtime and workflow contracts.

### Problems and implementation

The audited workflow code hard-codes CLI/direct execution. Orchestration lives in the renderer component, so navigation loses visible state while work may continue.

- Give the main process ownership of execution and state.
- Store execution mode, route, agent/provider/model, and autonomy explicitly.
- Define compatible defaults for existing templates.
- Persist step progress and terminal states.
- Allow views to reconnect to active workflows.
- Provide Stop and clear failure handling.
- Define explicit resume behavior for failed/interrupted workflows.
- Do not automatically replay completed steps or potentially destructive operations.
- Prevent duplicate starts and concurrent writes to the same workflow record.
- Route approvals to an available owning window.

### Acceptance tests

- [ ] API and proxy choices are honored.
- [ ] Navigation does not lose or duplicate execution.
- [ ] Reopening a workflow shows current progress.
- [ ] Stop cancels the active step and prevents subsequent steps.
- [ ] Failed/interrupted workflows resume only through explicit, predictable behavior.

## Phase 6 — Independent project windows

### User requirement

> A New Window action, with each window keeping its own selected project and conversation, while sharing settings and credentials.

### Primary files

- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/desktop-shell.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `packages/contracts/src/ipc.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/components/Chrome.tsx`
- Shared persistence services where concurrency requires changes.

### Implementation

1. Replace single-window assumptions with explicit window/session management.
2. Add a visible New Window action, command-palette entry, and `Ctrl+Shift+N` on Windows.
3. Keep project, conversation, navigation, and editor state independent per window.
4. Share settings, credentials, project history, and managed services.
5. Derive IPC ownership from the requesting renderer.
6. Route agent events, terminal output, approvals, dialogs, and errors to the correct window.
7. Broadcast genuinely shared updates where appropriate.
8. Ensure refreshing settings never switches another window's project.
9. Protect shared read-modify-write operations against lost updates.
10. Define behavior when windows open the same conversation or edit the same file.
11. Closing one window must not terminate another window's work.
12. Define owner-window closure behavior for active runs/approvals; prevent orphaned approval waits.
13. Preserve tray behavior and final application shutdown.
14. Preserve unsaved-work protection from phase 2.

### Acceptance tests

- [ ] Windows A and B select different projects independently.
- [ ] Concurrent commands send output to the correct window.
- [ ] Changing A's project leaves B unchanged.
- [ ] Reloading either renderer preserves its independent project context.
- [ ] Shared settings updates propagate without switching projects.
- [ ] Closing A leaves B and its work running.
- [ ] Dialogs and approvals reach the correct owner.
- [ ] Same-file writes retain conflict protection.
- [ ] Final shutdown cleans up managed resources correctly.

## Phase 7 — Release verification and delivery

The installed package inspected during the audit lacked the newer Learn persistence code. Source fixes alone therefore do not resolve the installed-app experience.

- Make builds identifiable through a version/build identifier.
- Build a fresh desktop package.
- Run packaged-app smoke tests with isolated application data.
- Verify necessary engine resources are included.
- Produce the installer/package and installation instructions.
- Do not silently replace the running installation.

## Validation and final handoff

Run relevant tests after each phase, then full validation:

```powershell
npm run desktop:typecheck
npm test
npm run desktop:build
npm run desktop:smoke
npm run desktop:smoke:workbench
```

Add targeted Electron integration tests for the acceptance criteria. Existing smoke tests passing is not sufficient.

Deliver:

1. An issue-by-issue implementation checklist.
2. Changed files and concise explanations.
3. Test results, including new regression coverage.
4. Remaining issues or unverified integrations.
5. Package location and build identifier.
6. A short manual verification checklist.
7. Migration, compatibility, and installation steps.

Do not claim live provider functionality was verified when only fixtures were used.
