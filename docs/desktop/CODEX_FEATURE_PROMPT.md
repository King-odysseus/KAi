# Prompt for Codex: KAI Desktop feature roadmap

Copy everything below the line into Codex.

---

You are implementing new features in the **KAI Desktop app**, an Electron + React app in this repository (`apps/desktop`). Work through the phases below **in order, one phase at a time**. At the end of each phase, stop and report back before starting the next one.

## How the app is built

- **Main process:** `apps/desktop/src/main/`. Services live here, for example `ipc.ts`, `proxy-client.ts`, `cognitive1-client.ts`, `service-controller.ts`, `checkpoints.ts`, `agent-runtime.ts`, `direct-provider-runtime.ts`, `credential-vault.ts` and `project-store.ts`.
- **Preload bridge:** `apps/desktop/src/preload/index.ts`.
- **Renderer (React 19):** `apps/desktop/src/renderer/src/`, with `App.tsx`, `components/*.tsx` and `styles.css`. Icons come from `lucide-react`.
- **Typed contracts (zod):** `packages/contracts/src/`, including `ipc.ts`, `domain.ts`, `brain.ts`, `proxy.ts` and `direct-providers.ts`. Every new IPC channel gets a zod schema here first. The main process validates both what comes in and what goes out, and the renderer calls it only through preload.
- **Cognitive1 (C1)** runs as a managed child service behind KAI's authenticated loopback. Its MCP tools are listed in `docs/desktop/FEATURE_PARITY.md`. Call C1 only through `cognitive1-client.ts`.
- **Universal Agent Proxy** runs as a managed service. Call it only through `proxy-client.ts`.
- **Tests:** vitest, in `test/desktop-*.test.ts`. Match the style of the existing files, such as `test/desktop-proxy.test.ts`, `test/desktop-brain.test.ts` and `test/desktop-contracts.test.ts`.
- **Source of truth:** `docs/desktop/FEATURE_PARITY.md` is the feature register. `updates.md` is the user-facing changelog.

## Ground rules (apply to every phase)

1. **Read before editing.** Read every file you change, in full, before you change it. Match the surrounding naming, comment density and idioms.
2. **The working tree already has uncommitted changes** from earlier work. Don't revert, reformat or "clean up" files you aren't changing for this task. Don't commit, don't rewrite git history, and leave all changes in the working tree.
3. **Checks after every phase.** All of these must pass:
   - `npm run desktop:typecheck`
   - `npm test`
   - `npm run desktop:build`
   - `npm run desktop:smoke`, extended to cover any new UI you add
   - Lint: `npm run lint` already fails with pre-existing errors. That's expected. Don't add new lint problems on lines you wrote. Don't add `eslint-disable` comments and don't change the ESLint config.
   - Never delete or skip a failing test to get green. Fix the cause, or stop and report.
4. **Tests for logic.** Every new main-process service, contract schema and client method gets a vitest test. Use real response shapes from the C1 and proxy sources as fixtures, not invented ones.
5. **Dependencies.** Don't run `npm install` or edit any `package.json` unless the phase explicitly allows it. When it does, add only the named package.
6. **Security and safety:**
   - Never modify `~/.claude`, `~/.codex`, `~/.qwen` or any other agent config on startup. Any writer for those configs is opt-in, backs the file up first and can be rolled back.
   - Secrets go only in the OS-backed credential vault (`credential-vault.ts`). Never write them to logs, history, IPC error messages or the renderer.
   - Subscription routes and paid API routes stay separate. Never fall back silently from one to the other.
   - Anything destructive or billable (prune, replay, restore, delete, a real paid request) needs an explicit confirmation in the UI.
   - All loopback calls stay authenticated and pinned to `127.0.0.1`.
7. **Sibling repos are read-only.** `../cognitive1` and `../ClaudeCode-Proxy` are reference sources. Don't edit them: a live daemon and another agent write to them.
8. **UI conventions:**
   - Use the existing theme tokens in `styles.css`. Every new screen has to work in both Dark and Light themes. Don't hard-code colours outside the token block.
   - Every new screen has to work at both 1440x920 and 960x640.
   - Every new action also gets a command-palette entry (Ctrl+K).
   - Anything that came from an agent, a file or the network is rendered as text, never as raw HTML.
9. **Spike before coding** for the phases marked **[SPIKE]**. Write a short design note in `docs/desktop/spikes/<phase>.md` covering the approach, the IPC contracts, the risks and the test plan. Then stop and wait for approval before writing any code.
10. **When a phase is done:**
    - Update the matching rows in `docs/desktop/FEATURE_PARITY.md`. Use `Integrated` once the service and UI evidence exist, and `Verified` only when the parity and smoke tests pass.
    - Add a dated entry to `updates.md`, newest first, in the same style as the existing entries.
    - Report what changed, which files, the test results and anything you deferred.

---

## Phase 1: Budgets and cost guardrails

The proxy already tracks cost (`/v1/costs`, surfaced through `proxy-client.ts`).

- Add budget settings to the app settings, validated by zod contracts: per-conversation, daily and monthly limits, optionally per provider, with a mode of **warn** or **block** at the limit.
- Enforce the budgets in the main process for both direct-provider runs and proxy runs.
  - At 80%, show a warning banner in the Workspace.
  - At 100%, in block mode, stop the run before it sends the next request. The run ends in a clear, resumable state, not as an error.
- Add a **Usage** page: spend over time, spend by provider, model and conversation, and remaining budget. Use the existing measured estimates and label them as estimates.
- **Tests:** crossing each limit, the warn and block modes, the reset at day or month boundaries, and the fact that a blocked run never sends the request.

## Phase 2: Tray icon and system notifications

- Add a system tray icon with these menu items: show or hide the window, the current run status, pause or stop the active run, and quit. Closing the window can minimise to the tray. Make this a setting that defaults to **off**.
- Send native Windows notifications when a run completes, when a run fails, when an approval is needed and when a budget warning fires (Phase 1). Clicking a notification focuses the right conversation.
- Each notification type gets its own on/off setting. Don't notify when the window is focused and the conversation is already on screen.
- **Tests:** the rules that decide whether to notify, and the settings contract.

## Phase 3: Interrupted-work recovery

This connects the C1 `checkpoint`, `recover`, `recap_check` and `compaction_check` tools.

- While a run is active, save a recovery checkpoint at each turn boundary: conversation, agent, route, goal, last tool state and the Git checkpoint reference.
- When the app starts after a crash, a force-quit or a killed run, show a **Recovery** view listing the interrupted runs. For each one, offer: **Resume**, which rebuilds the context from the checkpoint plus the recap, **View recap** and **Discard**.
- Use `compaction_check` to show a warning when the context is about to be too large, with a link to the existing Compact action.
- Add a crash-restart policy for the managed C1 and proxy services: a bounded number of restarts with backoff, then a clear failure state in the UI.
- **Tests:** a checkpoint written and read back, resuming after a simulated kill, the restart policy stopping at its limit, and never resuming automatically without the user choosing to.

## Phase 4: Native file, code and diff workspace [SPIKE]

This phase may add `monaco-editor` (and nothing else) as a desktop dependency. Justify that in the spike.

- Add a project **file tree** that respects `.gitignore` and hides large or binary files, plus a **Monaco editor** for viewing and editing files.
- Every file operation goes through a main-process service that enforces the project boundary. It rejects `..` paths and any symlink that leaves the project.
- Preserve line endings (CRLF or LF) and the encoding. Refuse to open binary files for editing. Warn when a file changed on disk after you opened it.
- Add a **diff view** for each agent turn, built on the existing checkpoints and `turn.changes` events. Show diffs side by side or inline, and let the user **accept or reject each hunk**, not only each file.
- **Tests:** these are required by FEATURE_PARITY. Escaping the project boundary, preserving CRLF, detecting binary files, symlinks, conflicts with a file edited on disk, and applying and rejecting individual hunks.

## Phase 5: Brain learning and review

This connects `brain_learn`, `brain_review_suggestions` and `brain_recall_feedback`.

- Add a **Save to Brain** action on assistant results and completed tasks. It opens a pre-filled entry (type, tags, project, body) that the user edits before saving. Surface C1's quality score and any duplicate warning before the save.
- Add a **Review queue** in the Brain view for C1's suggested and draft entries, with approve, edit and reject actions.
- Add thumbs up and thumbs down on search results in Brain search and in context lookups, recorded through `brain_recall_feedback`.
- **Tests:** client normalisation for each tool, and the approve and reject flows.

## Phase 6: Coordination: urgent warnings, active work and conflicts

This connects `urgent_set`, `urgent_clear`, `urgent_list`, `active_claim`, `active_release`, `active_list` and `conflict_check`.

- Show a global **urgent banner** with the active urgent warnings, plus controls to set and clear them.
- Add an **Active work** panel that lists current claims by agent and project. A run claims its project on start and releases the claim on end, cancel or crash (use the Phase 3 hooks).
- Before a run starts, run `conflict_check`. If another agent holds overlapping work, show a warning that the user can override.
- **Tests:** a claim is always released on every exit path, and a conflict produces a warning, not a block, unless the user chooses to block.

## Phase 7: Global search and Brain maintenance

This connects `recall` (cross-scope search), `brain_prune`, `brain_export` and `brain_stats`, plus the Brain sync controls.

- Add **global search** in the Ctrl+K palette covering Brain entries, daily logs, knowledge files and conversations, with results grouped by source.
- Add a **Maintenance** tab in the Brain view:
  - Prune, always as a dry-run preview first, then an explicit confirmation before applying.
  - Export a bundle, and import one that adds missing entries only and never overwrites.
  - Show the full statistics.
  - Git sync (pull and push) as explicit buttons with a status display. No background sync unless the user opts in.
- **Tests:** a dry-run prune never mutates anything, an import doesn't overwrite existing entries, and an export round-trip.

## Phase 8: Proxy providers, presets and live activity

- Add a **Provider registry** UI: add, edit and remove named providers from the proxy's presets. Keys go in the vault. Provider settings are validated, and any custom headers use an allowlist and have their values redacted.
- Connect **Test connection** (`/v1/test`) for a single provider and **Ping all** (`/v1/ping-all`) for provider health.
- Fill the model selectors from `/v1/models` rather than fixed lists.
- Add a **Live activity** feed from `/v1/history/live` (SSE) in the Proxy view, with auto-scroll, pause and filters.
- **Replay** from history:
  - Always show a preview first.
  - Require a confirmation that states the request may be billable.
  - Never replay automatically.
- Add controls for rate limiting, concurrency, the upstream timeout and the stall timeout. Keep the source proxy's semantics (429, 503, 504).
- **Tests:** a test for each new client method, SSE reconnect and cleanup, the replay confirmation, and redaction of headers and keys.

## Phase 9: Tasks, reviews and decisions

This connects `task_create`, `task_list`, `task_claim`, `task_complete`, `task_route`, `handoff_claim`, `review_request`, `review_list`, `decision_log`, `todo_project_create` and `todo_project_list`.

- Add a **Tasks** board (kanban-style: todo, in progress, review, done) for each project.
  - A task can be routed to an agent through `task_route`, with the suggestion shown and the user making the final choice.
  - A task can be started as a conversation.
  - A task can be completed with a result that feeds into Save to Brain (Phase 5).
- Add a **Handoff inbox** for claiming handoffs, and a **Review queue** for reviews that were requested.
- Add a **Decision log** timeline for each project. Allow recording a decision from any assistant message.
- **Tests:** client normalisation for each tool, and the state transitions on the board.

## Phase 10: Tests attached to the file version

- Whenever a test or check command runs (from an agent or from the user), record the result against the exact file versions it ran on: the Git checkpoint plus content hashes of the touched files.
- Mark a verification **stale** as soon as any of those files changes. In the diff view and the task view, show whether each file is verified, stale or unverified. Offer **Re-run** for stale results.
- Record regressions through `regression_log`, and show `regression_report` as a verification history.
- **Tests:** the stale-detection fixtures, and a repair followed by a rerun turning the status back to verified. FEATURE_PARITY requires both.

## Phase 11: Diagnostics page

This connects `doctor`, `compliance_audit`, `git_status`, `wiki_status`, `brain_ping`, `config_get` and `config_set`.

- Add one **Diagnostics** page showing:
  - The state of each service, with health, the restart count from Phase 3 and ports.
  - The C1 doctor output and the compliance audit (read-only).
  - The project's Git status.
  - The engine config, editable only through validated `config_set` with a confirmation.
- Add **Copy diagnostics bundle**: a redacted text or JSON report of versions, service states, recent errors and the log tail, for bug reports. Write a test proving no secrets or tokens appear in it.

## Phase 12: Sign in with a Claude Code or Codex account [SPIKE]

- In the spike, find out how the official Codex App Server and the Claude Code runtime authenticate. Check each CLI's `--help` and docs. Don't guess flags or endpoints.
- Implement sign-in through the official runtime flow only. Keep subscription credentials completely separate from API keys, and store them in the vault.
- Show the account state (signed in, signed out, expired) on the agent selector. Never fall back to a paid API when a subscription is signed out or rate-limited, unless the user has explicitly opted in to that.
- **Tests:** mocked auth states for every state and transition. A live smoke test can exist but must be opt-in and skipped by default.

## Phase 13: Windows installer and auto-update [SPIKE]

This phase may add `electron-updater` as a dependency.

- The app is for personal, noncommercial use, so **don't add code signing**. Leave the build unsigned, and add a short note to the install docs explaining the SmartScreen "More info → Run anyway" step.
- Use the NSIS target that already exists (`npm run dist --workspace @kai/desktop`). In the spike, write down the update channel and free hosting options (for example, GitHub Releases), then stop for a decision.
- Build auto-update with a user prompt before installing. Show release notes. Back up the app config before the update, and be able to restore it after one.
- Before the update installs, check that the engines are staged correctly, and that user data (Brain, settings, vault) survives the update.
- **Evidence:** a documented install on a clean machine, plus an update-and-restore checklist in `docs/desktop/`.

---

Start with **Phase 1**. Before writing any code, read `docs/desktop/FEATURE_PARITY.md`, `updates.md` (the latest entries) and the main, preload, contracts and renderer files that the phase touches. Then implement the phase, run every check, update the docs and stop with your report.
