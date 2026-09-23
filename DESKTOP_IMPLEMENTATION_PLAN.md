# KAI Desktop implementation plan

Created: 2026-09-23  
Status: Implementation in progress. Phase 0 evidence, the Phase 1 portable foundation, and the Phase 2 desktop shell are recorded. Phase 3 now packages and supervises both pinned engines and protects their loopback endpoints with OS-vault access tokens. Brain management, parity coverage, and recovery hardening remain open.

## Product outcome

Deliver a standalone Electron desktop application combining a coding workspace, direct API agents, the full Cognitive1 (C1) engine, and the full Universal Agent Proxy. Users install and launch KAI without VS Code or manually starting brain/proxy services.

The visual direction is the approved dark navy concept with mint action accents and lavender memory accents. Windows is the first release platform.

Full C1 and Universal Agent Proxy parity is a release requirement, not a claim about the existing embedded implementations. Their authoritative source locations and versions must be identified and audited before the parity scope can be finalised.

## Scope and boundaries

- Direct API mode must work without an external agent CLI.
- External agent CLIs remain optional integrations, with their own authentication and installation requirements.
- KAI packages and manages its own brain, proxy, and application runtime dependencies. It must not depend on a development machine's Node installation.
- Cloud inference requires network access and provider credentials. Offline inference requires a compatible local model runtime; bundling models is not part of the initial release.
- Project-specific tools such as Git, compilers, and package managers are detected and explained during setup. They are not assumed to be bundled.
- Preserve the existing extension while extracting shared functionality. The desktop release must run independently; continued extension distribution is a separate decision.
- No hosted account service, cloud memory sync, marketplace, or team collaboration service is required for the first release.

## Working rules

1. Read the affected source and applicable repository instructions before each implementation phase.
2. Implement a coherent phase at a time. Record evidence and remaining gaps before marking it complete.
3. Keep existing user edits, credentials, agent configuration, and private brain data intact. Do not automatically import or modify external agent configuration.
4. Add tests for changed runtime behaviour. Use realistic provider/CLI fixtures with credentials removed.
5. Establish compile, test, and lint baselines first. Do not claim existing checks pass without running them; do not expand existing failures.
6. For source changes, run the current repository checks and relevant new desktop checks. Pure planning-document changes do not need the runtime test suite.
7. Use incremental, recoverable data migrations and back up before migration. Never keep private data inside installation or source directories.
8. Update this plan's progress and `updates.md` as implementation ships. This document does not replace `UPGRADE_PLAN.md` for unrelated extension work.
9. Do not silently reduce full-engine parity to the existing lightweight embedded implementations. Any deferred source feature must remain visible in the parity register.

## Existing code: reuse and replacement map

| Area | Existing location | Desktop treatment |
| --- | --- | --- |
| Orchestration | `src/orchestrator/orchestrator.ts` | Extract behind host-independent interfaces; preserve goals, approvals, handoffs, and events. |
| Goals, permissions, skills | `src/core/` | Reuse after dependency and behaviour review. Replace VS Code logging dependency. |
| CLI integrations | `src/adapters/` | Reuse supported adapters; audit capabilities and approval semantics. |
| Proxy and translation | `src/proxy/` | Reuse tested behaviour where appropriate, then reconcile with the authoritative Universal Agent Proxy. |
| Embedded memory | `src/cognitive1/` | Compatibility starting point; integrate the full C1 engine after audit. |
| Conversation persistence | `src/panel/conversation-store.ts` | Extract from panel ownership and migrate to desktop persistence. |
| Checkpoints/worktrees | `src/orchestrator/checkpoints.ts`, `worktrees.ts` | Reuse with dirty-workspace protection and packaged environment tests. |
| Diff application | `src/orchestrator/vscode-diff-applier.ts` | Replace editor-dependent implementation with validated filesystem operations. |
| Settings and secrets | `src/config/` | Replace VS Code settings/SecretStorage with desktop services. Retain migrations only where applicable. |
| User interface | `src/panel/`, `src/extension.ts` | Replace extension activation and webviews with Electron shell and desktop UI. Reuse concepts and event contracts. |

## Target architecture

```text
Electron renderer: workspace, review, brain, proxy, workflows, history
    |
    | Narrow typed preload bridge; validated IPC
    v
Desktop host: windows, settings, credentials, dialogs, lifecycle
    |
    v
KAI runtime: conversations, goals, orchestration, permissions, verification
    |-- Direct API agent --> provider or managed proxy
    |-- Optional CLI adapters --> native harnesses
    |-- Project tools --> files, search, commands, Git, checkpoints
    |-- C1 service --> persistent brain storage
    `-- Universal Agent Proxy service --> configured upstreams
```

Use a sandboxed renderer with context isolation and no Node integration. Expose specific operations through preload rather than generic IPC or shell access. Validate request schemas, sender identity, project scope, and permissions in the privileged runtime.

Run long-lived engine work outside the renderer, with supervised child/utility processes where appropriate. Decide exact service boundaries after auditing engine runtimes. Package required runtimes; never assume a spawned `node` command exists on the user's PATH.

Suggested repository organisation, to confirm in Phase 1:

```text
apps/desktop/           Electron main, preload, renderer, packaging
packages/runtime/      Host-independent KAI orchestration and tools
packages/contracts/    IPC, events, persisted schema definitions
packages/integrations/ C1, proxy, provider, and CLI adapters
docs/desktop/          Architecture, parity register, release evidence
```

Select renderer tooling and packaging tooling during foundation work. Do not impose the legacy webview's ES5/no-build constraints on the new desktop renderer. An embedded editor and diff component can provide code review without requiring a VS Code installation.

## Feature inventory

### Desktop experience

- Navy interface with Workspace, Projects, C1 Brain, Universal Proxy, Workflows, History, and Settings navigation.
- Project picker, recent projects, project-specific defaults, and setup diagnostics.
- Streaming conversations, attachment/context selection, tool activity, approvals, task progress, and stop controls.
- Context sidebar with recalled memories, route/provider information, usage, and verification status.
- Keyboard navigation, visible focus, readable contrast, scalable text, resizable panels, and useful empty/error states.

### Providers and agents

- Separate agent/harness, provider/model, route, and autonomy concepts.
- Provide account sign-in through supported official agent runtimes as a first-class desktop experience, alongside direct API access. Normal operation must not require the user to type CLI commands.
- For Codex, integrate App Server's supported ChatGPT browser sign-in flow and account status/logout operations. KAI owns the interface while the official runtime manages subscription authentication and execution.
- For Claude Code, run the unmodified official runtime and use Anthropic's own sign-in flow with the user's account. Do not collect or repurpose Claude subscription session tokens for KAI's native API agent or universal proxy. Review the runtime's distribution and integration conditions before packaging it.
- Add explicit agent, connection/account, and model selectors. Example: Codex → ChatGPT account → an available Codex model; Claude Code → Claude account → an available Claude model.
- Populate model choices from supported runtime/provider discovery where available. Otherwise use a versioned, validated capability list and connection checks. Filter or explain unavailable choices; account entitlements, runtime versions, and provider restrictions still apply.
- Keep subscription connections distinct from API/proxy connections. Do not imply that a signed-in subscription permits arbitrary models, providers, or general API calls through the proxy.
- Show authentication state, active account when exposed by the runtime, reconnect/sign-out actions, and usage/limit information where available. Never silently switch from subscription usage to a billable API connection.
- Endpoint and credential configuration, connection tests, model selection, and capability detection/overrides.
- Native API tool loop with streamed responses, cancellation, bounded iteration, context management, and durable events.
- Explicit handling of tool-call IDs, fragmented streamed arguments, provider errors, rate limits, and unsupported features.
- Optional existing CLI adapters with truthful capability reporting; unsupported interactive approvals must not appear functional.

### C1 brain

- Full audited source-engine feature inventory and parity tests.
- Persistent project knowledge, personal preferences, session information, decisions, and handoffs.
- Retrieval with visible source, scope, and age; inspect memories used in a task.
- Search, edit, pin, exclude, delete, import/export, backup/restore, and health/storage views where supported or implemented as planned additions.
- Explicit project separation and user control over retention and recall.
- Record remote-service requirements for any engine feature; local storage alone does not imply fully offline functionality.

### Universal Agent Proxy

- Full audited source-engine feature inventory and parity tests.
- Providers, endpoints, credentials, model aliases, translation, streaming, and tool-call support.
- Routing profiles, health checks, service lifecycle, request activity, latency, usage, and actionable errors.
- Authenticated loopback endpoint usable by other tools; no LAN exposure by default.
- Document exact support for retries, fallbacks, load balancing, caching, and other advanced features after source audit. Do not promise unsupported behaviour.
- Retries must account for partial responses and possible side effects; do not automatically replay completed tool operations.

### Project tools and review

- File browser, code viewing/editing, search, attachments, and context preview.
- Scoped file operations and command execution with approval policy enforcement.
- Streaming command output, cancellation, timeout, and child-process cleanup.
- Diff review, accept/reject operations, Git awareness, checkpoints, and restore.
- Preserve existing user edits and detect file changes since a proposal/checkpoint before applying or restoring.
- Handle Windows paths, CRLF, Unicode, symlinks/junctions, binary files, and non-Git projects explicitly.

### Goals, workflows, verification, and usage

- Durable goals with outcome, constraints, and definition of done.
- Sequential workflows, reusable templates, structured handoffs, retry/change-agent controls, and persisted recovery state.
- Compare implementations in isolated worktrees with the same verification criteria.
- Distinguish agent completion from verified success, failure, cancellation, interruption, and skipped checks.
- Per-project build/test/lint/custom checks with output and timestamps tied to the checked revision or file state.
- Time, token, spending, and retry limits; measured and estimated values clearly separated.
- Explain limits of cost enforcement for delayed provider usage reports and external CLIs. Stop future work at the boundary and cancel in-flight work where supported; do not claim a perfectly hard dollar cap.

## Phase 0 — Audit sources and establish the baseline

Dependencies: none. Full parity work requires access to authoritative C1 and Universal Agent Proxy sources.

Tasks:

- [x] Locate both complete source projects and record repository/path, version or commit, licence, entry points, data formats, runtime dependencies, and supported platforms.
- [x] Create `docs/desktop/FEATURE_PARITY.md` with one row per source feature: source evidence, integration approach, UI/API exposure, dependencies, test evidence, and status.
- [x] Distinguish source features from requested desktop additions. Mark unknowns as unresolved rather than implemented.
- [x] Inventory VS Code imports and transitive dependencies; map them to host interfaces.
- [x] Run baseline compile/tests/lint, review repository state, and record existing failures without overwriting user work.
- [x] Audit actual workflow failure, skip, interruption, and completion behaviour before reuse.
- [x] Inventory existing user-data formats and identify explicit import paths without touching live data.

Acceptance: source versions and complete feature inventories are recorded; blockers have named dependencies; reuse decisions and baseline results are reviewable. If sources are unavailable, desktop foundation can proceed, but full parity cannot be declared complete.

## Phase 1 — Extract the portable runtime and define contracts

Dependencies: baseline and host-coupling audit from Phase 0.

Tasks:

- [x] Define interfaces for settings, secrets, logging, file access, diffs, notifications, service lifecycle, and persistence.
- [ ] Move or wrap shared orchestration without changing the extension's behaviour unintentionally.
- [ ] Separate agent ID, provider ID, model ID, route, and capability metadata.
- [x] Define typed, versioned event and IPC schemas with runtime validation.
- [ ] Define conversation, goal, workflow, verification, checkpoint, and service-state schemas.
- [x] Choose desktop build/package tooling and persistence approach; document decisions in `docs/desktop/ARCHITECTURE.md`.

Acceptance: portable runtime tests run without importing `vscode`; the existing extension still compiles; malformed IPC/events are rejected; schema migrations have fixtures.

## Phase 2 — Desktop shell and durable local state

Dependencies: Phase 1 contracts.

Tasks:

- [x] Create Electron main/preload/renderer boundaries and a Windows development launch command.
- [x] Implement the navy layout, navigation, project picker, resizable workspace, and settings shell.
- [x] Implement app-owned configuration and conversation persistence using atomic writes or transactional storage.
- [x] Add OS-backed credential encryption with explicit handling when a secure backend is unavailable; never silently fall back to plaintext.
- [x] Add single-instance handling, window restoration, startup errors, and orderly shutdown.
- [x] Validate external links, keep remote content unprivileged, and apply a Content Security Policy.
- [x] Add redacted diagnostics and a data-location screen.

Acceptance: app launches without VS Code, remembers projects/conversations across restarts, keeps credentials outside the renderer and logs, and passes keyboard/navigation smoke tests.

Implementation evidence (2026-09-23): portable and desktop typechecks pass; the extension compile and 39-file/319-test baseline pass; Electron production build succeeds; `desktop:smoke` launches the built app, navigates Settings, saves settings, toggles the context panel, and captures verified layouts at 1440x920 and 960x640. Project preferences are persisted separately from settings. Signing and installer validation remain Phase 7 work.

## Phase 3 — Package the full brain and proxy engines

Dependencies: authoritative source audit and Phases 1–2. Brain and proxy integration are separate workstreams within this phase.

Tasks:

- [x] Integrate pinned full-engine implementations using documented adapters; avoid accidental divergence from their source behaviour.
- [ ] Package required runtime dependencies and supervise start/stop/restart, readiness, crashes, and version compatibility.
- [ ] Handle occupied ports, duplicate instances, timeouts, orphan processes, and recovery with clear status.
- [x] Store engine data in app-owned or explicitly selected user directories; migrate copied/imported data with backups.
- [ ] Implement brain search/inspection/management and proxy configuration/activity screens.
- [x] Add authenticated loopback access, token rotation, and credential redaction.
- [ ] Verify every parity-register feature through service/API tests and UI checks where applicable.

Acceptance: both engines operate from the packaged app with VS Code closed and no separately started server; core memory survives restart; proxy streaming/tool translation works; all source features are accounted for. Any unresolved parity row remains a release blocker or an explicit scope decision.

Implementation evidence (2026-09-23): `desktop:package` produces an unpacked Windows app containing staged Cognitive1 1.0.0, Universal Agent Proxy 1.9.0, production engine dependencies, and the proxy launcher. A packaged `KAI.exe` smoke started both engines, reached ready, copied each OS-vault token, proved unauthenticated requests return 401 and bearer-authenticated health requests return 200, rotated the proxy token, proved the old token was rejected, and shut down without leaving the smoke process or engines running. The same smoke seeds a temporary Cognitive1 brain, reads overview and search results through typed IPC, renders the Brain screen at 1440x920 and the minimum window size, updates a field, and verifies the refreshed value. It also sends a deliberately unreachable proxy request, verifies the failure in typed history and detail APIs, renders proxy cost/health/latency/history activity at 1440x920 and 960x640, opens the detail inspector, and asserts that the Brain, Proxy, and Settings content surfaces fill their page width at both sizes. The full suite passes 42 files and 327 tests; compile, both typechecks, production build, package build, `npm audit --omit=dev`, and the packaged real-engine smoke pass. Source commit warnings remain intentionally non-fatal for Cognitive1 brain-sync commits; `KAI_ENGINE_STRICT_COMMIT=1` still enforces the audited code commit. Crash restart policy, occupied-port recovery beyond clear bind failure, Brain import/export and remaining maintenance controls, and the remaining proxy and parity-register rows remain open.

## Phase 4 — Direct API agent and project tools

Dependencies: desktop shell, runtime contracts, and managed proxy interfaces.

Tasks:

- [ ] Implement provider adapters and capability-aware direct/proxy routes.
- [ ] Implement streaming conversation and the bounded tool execution loop with validated arguments and durable tool results.
- [x] Add file read/search/edit and command tools with project boundary checks and approval enforcement.
- [x] Add first-class stdio and Streamable HTTP MCP server configuration, lifecycle, tool discovery, approval enforcement, and invocation through the same bounded tool loop.
- [x] Add context preview and token estimates for selected files, instructions, skills, and memories.
- [x] Integrate scoped C1 recall and session/handoff recording without treating retrieved content as privileged instructions.
- [x] Implement provider-error retry/rate-limit recovery and cancellation without replaying already executed tools.
- [ ] Add explicit ambiguous tool-outcome recovery so interrupted side effects are surfaced rather than blindly retried.
- [ ] Add API/model connection diagnostics and transparent usage reporting.

Acceptance: with only provider credentials, a user can open a project, ask for a code change, approve required actions, inspect the result, and stop execution. Tests cover streamed tool arguments, malformed responses, denied actions, path escape attempts, interruption, and credential redaction.

Interim CLI evidence (2026-09-23): the packaged desktop app discovers Claude, Codex, Qwen, and Gemini through typed IPC, checks both executable version and native sign-in state, and runs existing CLI accounts without modifying their global configuration. The composer persists user/assistant turns and native session IDs, reports unavailable or failed agents in the UI, exposes typed cancellation through a Stop control, distinguishes sign-in-required from not-installed agents, and launches each installed CLI's official interactive sign-in flow in a separate console. Install guidance links to the vendor's setup documentation; KAI does not collect vendor account credentials. A live installed-app Codex run completed in read-only mode and persisted its reply. This improves optional CLI support but does not complete the direct provider API, streaming tool loop, approvals, project-boundary tools, or the planned Codex App Server account UI required by Phase 4.

Interim direct API evidence (2026-09-23): OpenAI Responses API text runs stream through typed main-process IPC, persist the assistant turn and response ID, resume with `previous_response_id`, report measured token usage and provider errors, and cancel cleanly. Direct API execution is an explicit composer mode and never falls back to a subscription CLI or another credential; the renderer never receives the API key. OpenAI is the only implemented adapter at this point, and direct API mode is text-only with `supportsTools: false`. A local fake OpenAI-compatible SSE provider covers streaming, authorization, continuation, usage, provider errors, and cancellation, and the desktop smoke verifies the same path through the app. The later direct API, context, memory, and retry evidence below supersedes this interim boundary.

Bounded-tool and MCP evidence (2026-09-23): direct API runs now execute up to eight provider tool rounds, return durable tool results to the model, accumulate measured usage, and enforce project-contained paths including existing symlinks. Read/search/create/edit and command tools are available. Plan mode denies writes and commands; Ask mode uses an in-app approval response; Auto-edit permits file writes but still asks before commands; Full permits the model to run them. Command execution has project-relative working-directory validation, a 120-second maximum timeout, bounded output, structured exit status, and process-tree cancellation on timeout or Stop. Local stdio and remote Streamable HTTP MCP servers are configured in Settings with vault-backed environment or header references. KAI connects with the official MCP TypeScript SDK, discovers and namespaces tools, applies the same approval policy, and closes connections on config invalidation or app shutdown. Production, packaged, and installed-app smokes pass end-to-end direct API calls through stdio MCP, authenticated Streamable HTTP MCP, and the approved command path. Isolated tests also verify cancelled commands, timeouts, exit failures, remote credential headers, discovery, policy, and invocation. The context and scoped-memory evidence below records later recall and provider retry work.

Context and scoped-memory evidence (2026-09-23): context preview now estimates project instructions, recently changed files, skill metadata, and scoped Cognitive1 memories. Recalled entries are filtered by the project identity derived from its package manifest or folder name, bounded to eight results, truncated, and explicitly presented to the provider as untrusted historical reference rather than instructions. Direct API runs start a Cognitive1 session lazily for the conversation, record a structured handoff when the active agent changes, close the session after a failed run so recovery state is available, and close active sessions before KAI stops its managed engines. Memory lifecycle events are persisted with the conversation. Direct provider requests retry transient connection failures, `408`, `409`, `425`, `429`, and `5xx` responses up to three attempts with bounded exponential delay and `Retry-After` support; retry attempts are persisted as lifecycle events, while already executed project or MCP tools are never replayed. The full suite passes 47 files and 358 tests with one opt-in live test skipped; desktop and portable typechecks, production packaging, real-engine packaged smoke, and direct API smoke against both the fresh unpacked build and the reinstalled `KAI.exe` pass. Installer SHA-256: `9C3D2925208596E5476BF4F1DF60BCCAB0C2CFC9D8D9572E3B581312DBCEEDF4`. Additional provider adapters and live-key testing remain open.

## Phase 5 — Change review, checkpoints, and verified completion

Dependencies: Phase 4 project tools.

Tasks:

- [ ] Add file/code and diff views with accept/reject controls.
- [ ] Implement checkpoints and restoration that preserve pre-existing and subsequent user edits or report conflicts.
- [ ] Provide explicit behaviour for untracked files, deletions, binary files, and non-Git projects.
- [ ] Add configured build/test/lint/custom verification commands and collect structured results.
- [ ] Model agent-finished and verification states independently; stream termination alone is not proof of success.
- [ ] Attach verification to the checked file state and mark it stale after further edits.
- [ ] Add bounded repair-from-failure actions.

Acceptance: demonstrate a failed test leading to a repair and passing rerun; show skipped checks honestly; prove stale checks are marked; verify restore against dirty-workspace fixtures and Windows line endings.

## Phase 6 — Goals, workflows, recovery, and budgets

Dependencies: persistence, API/tool execution, and verification.

Tasks:

- [ ] Persist goals, step dependencies, prompts, handoff packets, outcomes, and checkpoints.
- [ ] Implement sequential workflows and templates with explicit skipped/failed dependency rules.
- [ ] Add pause/resume, retry, change-agent, cancellation, and restart recovery.
- [ ] Reconcile interrupted steps with actual file/process state before resuming; never assume unfinished operations did nothing.
- [ ] Add time/token/cost/retry limits and usage views with estimate provenance.
- [ ] Add optional CLI integrations with install/auth diagnostics and capability tests.
- [ ] Implement desktop-driven ChatGPT sign-in through Codex App Server and official Claude Code account sign-in, including cancelled login, expired credentials, reconnect, and sign-out states.
- [ ] Add agent/account/model selectors with capability-aware choices; preserve compatible project/conversation defaults and handle model access changes.
- [ ] Verify subscription routes stay with their official runtimes, API/proxy routes use the selected credentials, and changing billing mode requires an explicit user choice.
- [ ] Verify a user can sign in, choose an agent and supported model, send a task, respond to approvals, and review changes without manually entering terminal commands. Runtime setup requirements must be visible and managed where distribution permits.
- [ ] Add isolated comparison runs and apply-winner conflict handling with equivalent verification.

Acceptance: a restart resumes from a reviewed safe boundary without duplicating edits; failed or skipped required checks cannot produce verified completion; exhausted budgets prevent further dispatch; comparison runs do not write to the same working tree.

Account integration acceptance: demonstrate separate runs using the user's ChatGPT account through Codex and Claude account through official Claude Code, plus a direct API run. Display the actual selected agent/connection/model, handle unavailable models and expired sign-in accurately, and never fall back to paid API usage silently. Live account tests require the user's own official login; use mocked auth events for routine automated tests.

## Phase 7 — Release packaging and end-to-end validation

Dependencies: prior acceptance checks and complete parity register.

Tasks:

- [ ] Build a Windows installer including all KAI engine/runtime assets.
- [ ] Test on a clean Windows environment without VS Code, development Node, or agent CLIs.
- [ ] Detect missing project tools and provide actionable setup guidance.
- [ ] Verify installation paths with spaces, standard-user operation, firewall/port failures, offline startup, and service crash recovery.
- [ ] Add tested backup/export/restore and transactional, versioned upgrades with recovery procedures.
- [ ] Choose update distribution and code-signing arrangements; require explicit release authorisation before publishing or uploading builds.
- [ ] Document data locations, external dependencies, provider setup, memory controls, and diagnostic export.
- [ ] Review accessibility, rendering at common Windows display scales, long sessions, and bounded log/event storage.

Acceptance: install and complete a real project task on a clean machine; restart and recall task knowledge; verify proxy use from an external client; backup/restore successfully; no credential leakage or orphan engine processes; source parity checklist is complete and signed off for release.

## Verification strategy

| Layer | Required evidence |
| --- | --- |
| Portable runtime | Unit tests for goals, approvals, state transitions, budgets, schema migration, and recovery. |
| Providers/proxy | Recorded fixtures and local test servers for translation, streaming, errors, tool calls, cancellation, and routing. |
| C1 | Source parity tests plus persistence, project separation, recall provenance, import/export, and deletion checks. |
| Files/processes | Temporary-project integration tests covering dirty trees, conflicts, path boundaries, line endings, process cleanup, and interruption. |
| Desktop UI | Electron end-to-end tests for onboarding, sending a task, approvals, diffs, verification, restart, brain, and proxy controls. |
| Packaged release | Clean-machine installation and service lifecycle tests, separate from development-mode success. |

Use test credentials and deterministic local fixtures for routine checks. Live provider smoke tests are opt-in and must state their external requirements. Choose exact desktop test commands when tooling is introduced; retain existing repository commands for the code they cover.

## Milestones and definition of release-ready

1. **Desktop foundation:** standalone window, projects, settings, credentials, and persistent conversations.
2. **Integrated services:** packaged full C1 and proxy, visible health, and audited parity coverage.
3. **Useful coding app:** direct API task changes files, shows a diff, runs verification, and recalls the result after restart.
4. **Dependable workbench:** recoverable workflows, budgets, optional CLI agents, and isolated comparison.
5. **Windows release candidate:** clean-machine install succeeds and all release checks have evidence.

The release is not complete simply because the Electron window opens. It must prove the full user flow:

> Install KAI → choose a project → configure a provider → request a change → review the diff → verify the result → restart KAI → recover the conversation and relevant brain knowledge.

## Open decisions and dependencies

| Item | Resolution point | What it blocks |
| --- | --- | --- |
| Full C1 source path/repository and version | Phase 0 | Complete brain inventory, runtime packaging, and parity claim. |
| Full Universal Agent Proxy source path/repository and version | Phase 0 | Complete proxy inventory, runtime packaging, and parity claim. |
| Third-party licences and redistribution constraints | Phase 0 | Bundling and public release. |
| Renderer, editor/diff component, and packaging tooling | Phase 1 | Desktop build foundation; choose after compatibility review. |
| Persistence engine and existing-data import policy | Phases 1–2 | Migration and recovery implementation. |
| Initial provider support matrix | Phases 0–4 | Provider-specific acceptance tests. |
| Update hosting, signing identity, and publication destination | Phase 7 | Distributed signed release and automatic updates. |
| macOS/Linux releases and bundled local inference | After Windows scope is proven | Future platform/offline distribution work. |

No implementation time estimate is committed before auditing both full engines. Their runtime dependencies, existing test coverage, and redistribution terms determine much of the integration effort.

## Reference guidance

- Codex App Server, including ChatGPT browser authentication: https://learn.chatgpt.com/docs/app-server
- Codex authentication and subscription/API distinction: https://learn.chatgpt.com/docs/auth
- Claude Code integration and account credential conditions: https://code.claude.com/docs/en/legal-and-compliance
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron context isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron credential encryption: https://www.electronjs.org/docs/latest/api/safe-storage

Check current official documentation when selecting versions and implementing integrations.
