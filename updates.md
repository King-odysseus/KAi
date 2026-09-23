# KAI Agent Workbench — Updates

## 2026-09-23

### Composer controls and authoritative Cognitive1 rules

- **Agent, route, and autonomy controls are now functional and readable.** The
  workspace can switch agent harnesses, select Direct or the authenticated
  Universal Proxy route in API mode, and choose Plan, Ask, Auto-edit, Full
  control, or Custom permissions. Workspace menus use an in-app dark dropdown
  with light option text, a mint selected state, and keyboard navigation instead
  of relying on the Windows popup theme.
- **DeepSeek and other API providers are visible in the composer.** API mode
  shows the configured provider and model, including DeepSeek API and
  OpenRouter, and links directly back to provider settings.
- **The complete Cognitive1 `Instruct.md` is bundled inside KAI.** The 57-rule
  authoritative document is copied into the app during engine staging and is
  injected before every CLI or direct API run. Project context follows it, and
  the context preview records the bundled source explicitly.
- **Universal Proxy routing now has a real direct API path.** Selecting Proxy in
  API mode sends the request through KAI's authenticated loopback proxy using
  the proxy access token, not the provider credential.
- **Dark and Light themes are both available and persisted.** A title-bar
  toggle switches the full desktop interface immediately, and the Settings page
  includes the theme as an explicit saved preference. Light mode applies across
  the workspace, menus, settings, context, Brain, Proxy, dialogs, and data
  tables while preserving contrast and full-width layouts.

### Direct API provider catalog

- **Desktop direct API settings now support OpenRouter and other popular
  OpenAI-compatible providers.** The provider picker includes DeepSeek,
  OpenRouter, Groq, Mistral, xAI, Together AI, Fireworks AI, and a custom
  OpenAI-compatible endpoint alongside the existing OpenAI Responses API.
- **OpenRouter can use any model ID exposed by OpenRouter.** The model field is
  free text with suggestions for popular OpenAI, Anthropic, Google, DeepSeek,
  xAI, Qwen, Meta, and Mistral model IDs. OpenRouter requests include KAI
  attribution through `X-Title`.
- **Chat Completions providers stream text, fragmented tool arguments, usage,
  and errors through the same project, command, approval, and MCP tool loop.**
  Retries, cancellation, measured token usage, multi-turn history, and the
  existing project boundary rules are shared with direct API runs.

### Desktop project tools, approvals, and MCP

- **Direct API runs now execute a bounded provider tool loop.** Up to eight model
  tool rounds can read, search, create, or edit files inside the active project,
  and every result is returned to the model and persisted with the conversation.
  The provider session ID is retained across tool follow-ups and usage is summed
  across rounds.
- **Project boundaries are enforced in the main process.** Paths are resolved
  against the selected project, existing symlinks are resolved before access,
  path escapes are rejected, file reads/searches are size-limited, and create
  operations never overwrite an existing file.
- **File changes use explicit approval.** The desktop shows an in-app approval
  card with the tool and exact arguments. Plan mode denies writes, Ask mode waits
  for approval, Auto-edit and Full allow them, and Stop resolves pending
  approvals without leaving the run hanging.
- **MCP servers are now first-class direct API tools.** KAI uses the official
  Model Context Protocol TypeScript SDK, discovers server tool schemas,
  namespaces tool names by server, applies the autonomy/approval policy, and
  returns MCP results through the same bounded loop. Both local stdio servers
  and remote Streamable HTTP servers are supported. Credential environment
  variables and HTTP headers reference OS-vault IDs, so MCP secrets do not enter
  the renderer or settings file. Server processes close when configuration is
  replaced or the app exits.
- **Settings can configure local and remote MCP servers.** Local servers have a
  command, arguments, optional working directory, enabled state, and an
  `ENVIRONMENT_VARIABLE=credential.id` mapping. Remote servers have a URL,
  credential-backed header mapping, and the same enabled state. Disabled and
  failed servers do not prevent built-in project tools from running.
- **Shell commands now run through a high-risk approval gate.** Plan mode denies
  commands, Ask/Auto-edit/Custom require approval, and Full mode may run them.
  Commands start inside a validated project-relative directory, have a maximum
  runtime, cap captured output, report exit status and duration, and terminate
  the process tree on timeout or Stop.
- **Direct API runs now include a visible, bounded project context.** The context
  panel estimates instruction, recently changed file, skill metadata, and memory
  tokens. Instruction files and selected files are read only from inside the
  project, large files are truncated, path escapes are ignored, and skill
  metadata is indexed without loading full skill instructions into every run.
- **Scoped Cognitive1 recall is reference data, not instructions.** Recall is
  filtered to the active project identity, capped and truncated, and the
  provider-facing context explicitly says remembered content cannot override the
  user request, project instructions, or tool policy.
- **C1 session and handoff state now follows the conversation.** A direct API
  conversation starts a Brain session lazily, records a structured handoff when
  the agent changes, closes the session after a failed run for recovery, and
  closes any remaining active sessions before KAI stops the managed engine.
  These lifecycle events persist with the conversation.
- **Transient provider failures now retry without replaying tools.** Connection
  failures and retryable HTTP statuses use up to three bounded exponential-backoff
  attempts, honor `Retry-After`, and persist each attempt as lifecycle evidence.
  Retries wrap only the provider request, so completed file, command, and MCP tool
  actions are not executed a second time.
- **Verification:** 48 test files and 366 tests pass with one opt-in live test
  skipped by default. Tests cover streaming tool calls, argument validation,
  approval allow/deny paths, path escape and symlink escape attempts, vault-backed
  stdio and Streamable HTTP MCP credentials, read-only MCP policy, malformed
  edits, cancellation, scoped untrusted memory context, session lifecycle,
  handoff normalization, and retry/rate-limit recovery. The rebuilt packaged app
  and the installed `KAI.exe`
  both pass end-to-end smokes where the model calls `mcp_smoke_echo`, KAI invokes
  the configured local stdio and remote Streamable HTTP MCP servers, returns each
  result to the provider, and persists the final reply. The installed command
  smoke also verifies the approval dialog, process execution, stdout capture, and
  provider follow-up. The same installed smoke verifies a populated context
  preview and the context meter. Installer SHA-256:
  `C516DFF9C99A9B6E91EE2D97F8C1667EE3DBA974C6987701920A971D834FD418`.

**Files:** `apps/desktop/src/main/project-tools.ts`,
`apps/desktop/src/main/mcp-runtime.ts`,
`apps/desktop/src/main/direct-provider-runtime.ts`, `apps/desktop/src/main/ipc.ts`,
`apps/desktop/src/main/context-builder.ts`,
`apps/desktop/src/main/cognitive1-client.ts`,
`apps/desktop/src/renderer/src/components/SettingsView.tsx`,
`apps/desktop/src/renderer/src/components/Workspace.tsx`,
`packages/contracts/src/domain.ts`, `packages/runtime/src/atomic-json-store.ts`,
`test/desktop-project-tools.test.ts`, `test/desktop-mcp.test.ts`,
`test/desktop-context.test.ts`, `test/desktop-brain.test.ts`,
`test/desktop-direct-provider.test.ts`,
`apps/desktop/scripts/smoke.mjs`

**Next:** add the remaining provider adapters.

### Desktop direct provider API

- **CLI and API execution are now explicit, separate routes.** The composer has a
  `CLI / API` selector. API runs never silently fall back to an official CLI or
  subscription account, and CLI sessions keep their existing native session IDs.
- **The first direct provider adapter uses the OpenAI Responses API.** It streams
  SSE text into the active turn, records measured input/output token usage,
  resumes follow-up messages with `previous_response_id`, reports provider
  failures, and supports cancellation without deleting persisted turns.
- **Direct API credentials stay in the OS vault.** The Electron main process
  reads the selected credential and sends it only on the provider request; the
  renderer receives capability and status data, never the key or authorization
  header.
- **Settings now configure direct API mode.** Provider, model, base URL, and vault
  credential are validated before a run, and incomplete or unsupported setups
  remain visible instead of falling back to another route. OpenAI is implemented;
  Anthropic, Google, and OpenAI-compatible provider selections are placeholders
  until their adapters are implemented.
- **This first direct-API milestone was text-only.** The project tool loop,
  approvals, and MCP support above now supersede that initial boundary.
- **Verification:** 44 test files and 341 tests pass with one opt-in live test
  skipped by default. The direct-provider fixture verifies streaming,
  credential use, continuation, provider errors, usage, and cancellation. The
  desktop production build and direct API Playwright smoke pass with a local
  OpenAI-compatible SSE fixture; no user API key was required.

**Files:** `apps/desktop/src/main/direct-provider-runtime.ts`,
`apps/desktop/src/main/ipc.ts`, `apps/desktop/src/preload/index.ts`,
`apps/desktop/src/renderer/src/App.tsx`,
`apps/desktop/src/renderer/src/components/Workspace.tsx`,
`apps/desktop/src/renderer/src/components/SettingsView.tsx`,
`packages/contracts/src/agents.ts`, `packages/contracts/src/domain.ts`,
`test/desktop-direct-provider.test.ts`, `apps/desktop/scripts/smoke.mjs`

**Follow-up:** the command tool, Streamable HTTP MCP, context estimates, C1
recall/session recording, and provider retry handling are recorded in the newer
entries above.

### Desktop CLI agents and working direct chat

- **Agent runs can now be stopped from the composer.** While a CLI is working,
  the Send control becomes a Stop control and routes through typed cancellation
  IPC to terminate the active process without deleting the persisted turns.
- **Unavailable agents now show the real setup state.** The selector
  distinguishes sign-in-required from not-installed agents, keeps unavailable
  choices selectable so their guidance is reachable, and offers a refresh action
  after setup changes.
- **KAI can launch the official account flow for an installed CLI.** Claude,
  Codex, Qwen, and Gemini sign-in open in a separate interactive console using
  each vendor's own authentication command. KAI does not collect the account
  credentials; installation remains an external prerequisite with an in-app
  vendor guide link.
- **The desktop composer now runs the selected agent CLI instead of only saving
  the prompt.** New and existing conversations execute through the main process,
  persist the user and assistant turns, keep native session IDs for follow-up
  messages, and surface launch, authentication, or process failures in the UI.
- **All four supported CLIs are detected from the packaged app.** Capability
  reporting checks both the executable version and each CLI's own sign-in status,
  so an installed but unauthenticated agent is shown as unavailable with an
  actionable sign-in hint instead of appearing ready.
- **Direct routes do not modify global CLI configuration.** The desktop runtime
  uses each official CLI's existing account and permissions, runs in the selected
  project directory, and keeps `ask`/`plan` autonomy read-only until explicit
  approval plumbing exists. Proxy routing remains rejected with a clear message
  until that integration is implemented.
- **Verification:** 43 test files and 337 tests pass with one opt-in live test
  skipped by default. The live Codex test passes when enabled. The rebuilt
  installed app detected `claude=ready`, `codex=ready`, `qwen=ready`, and
  `gemini=unavailable` (not signed in), then completed a real installed-app
  conversation through Codex, rendered `KAI_CLI_OK`, and persisted both turns.

**Files:** `apps/desktop/src/main/agent-runtime.ts`, `apps/desktop/src/main/ipc.ts`,
`apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/App.tsx`,
`apps/desktop/src/renderer/src/components/Workspace.tsx`,
`packages/contracts/src/agents.ts`, `test/desktop-agents.test.ts`,
`test/desktop-agents-live.test.ts`

**Next:** add desktop-driven sign-in and install guidance, then complete the
provider tool loop, approvals, and project tools for Phase 4.

### Standalone desktop foundation

- **A standalone Electron shell now runs independently of VS Code.** The app has
  a sandboxed React renderer, a narrow typed preload bridge, validated IPC, and
  separate main/preload/renderer builds.
- **Projects, settings, conversations, and project preferences persist below
  the app's user-data directory** using versioned schemas and atomic JSON
  replacement. Existing extension data is not imported automatically.
- **Credentials use Electron `safeStorage` only.** KAI reports when OS-backed
  encryption is unavailable and never falls back to plaintext credential files.
- **The desktop workbench includes** navigation, a project picker, resizable
  conversation/context panels, workspace and history views, service status
  shells, settings, redacted diagnostics, and a data-location screen.
- **Verification:** portable and desktop typechecks pass, the production
  Electron build succeeds, all 39 extension/desktop test files pass (319
  tests), and the Playwright Electron smoke test passes at 1440x920 and
  960x640.

**Files:** `apps/desktop/`, `packages/contracts/`, `packages/runtime/`,
`docs/desktop/`, `test/desktop-contracts.test.ts`,
`test/desktop-runtime.test.ts`

**Next:** Phase 3 integrates the pinned full Cognitive1 and Universal Agent
Proxy engines and verifies every parity-register row through packaged
service/API tests.

### Packaged Cognitive1 and Universal Agent Proxy services

- **KAI now packages both pinned engines and their production dependencies.**
  The unpacked Windows app contains Cognitive1 1.0.0, Universal Agent Proxy
  1.9.0, and the KAI-owned proxy launcher. Engine payloads stay outside the
  application source and are written below the app data directory at runtime.
- **Managed services start in isolated child processes.** Start, stop, restart,
  readiness checks, version reporting, log redaction, and bounded forced
  shutdown are handled outside the renderer and use Electron's embedded Node
  runtime instead of a system Node installation.
- **Loopback access is authenticated.** Each service binds a private ephemeral
  port and exposes only a token-protected loopback gateway. Tokens are stored in
  the OS vault, copied through a main-process clipboard action, and can be
  rotated; rotation immediately invalidates the previous token. Vault writes are
  serialized to prevent concurrent startup from losing either service token.
- **C1 Brain and Universal Proxy pages show live state** with version, endpoint,
  authentication status, start/stop/restart controls, and access-token actions.
- **Verification:** 40 test files and 323 tests pass; compile, portable and
  desktop typechecks, production build, `npm audit --omit=dev`, development
  real-engine smoke, and packaged real-engine smoke pass. The packaged smoke
  proves 401 without a token, 200 with a token, rotation rejects the old token,
  and both engines shut down cleanly.

**Files:** `apps/desktop/`, `packages/integrations/`,
`packages/contracts/src/ipc.ts`, `packages/contracts/src/primitives.ts`,
`docs/desktop/`, `test/desktop-integrations.test.ts`

**Next:** implement brain search/management and proxy activity screens, then
close the remaining parity-register rows with service/API tests.

### Native Cognitive1 Brain search and inspection

- **The C1 Brain page now reads live Brain state through the authenticated
  managed-engine gateway.** It shows entry totals, type counts, active agents,
  project count, hunger, signal ratio, noise, duplicates, untagged entries, and
  dead-weight counts without exposing the loopback token to the renderer.
- **Memory can be searched by query, type, tag, and project.** Results show the
  Brain type, title, project, agent, date, tags, status, and structured fields.
  Superseded entries remain hidden according to Cognitive1 recall behavior.
- **Structured fields can be edited in place.** Updates go through typed IPC and
  the main-process client to Cognitive1's `/api/brain/edit-field` endpoint, then
  refresh the visible overview and search results.
- **Verification:** the isolated authenticated-gateway client test passes; the
  full suite passes 41 files and 325 tests; the development and packaged
  real-engine smokes seed a temporary brain entry, search it through IPC, render
  it at 1440x920 and 960x640, update a field, and verify the refreshed value.
  Brain import/export, pin/exclude/delete controls, and proxy activity history
  remain open.

**Files:** `apps/desktop/src/main/cognitive1-client.ts`,
`apps/desktop/src/main/ipc.ts`, `apps/desktop/src/renderer/src/components/BrainView.tsx`,
`packages/contracts/src/brain.ts`, `test/desktop-brain.test.ts`

**Next:** implement proxy activity/history and the remaining Brain
maintenance/import-export controls, then continue closing parity-register rows.

### Native Universal Agent Proxy activity and history

- **The Universal Proxy page now reads live cost, cache, latency, provider, and
  model data through the authenticated managed-engine gateway.** Provider rows
  show circuit state, reachability, success rate, call count, and P95 latency;
  model rows show call, token, and measured-cost totals.
- **Request history is searchable and paginated.** Each record shows status,
  agent, provider, model, latency, and time. Selecting a request opens routing,
  endpoint, retry, fallback, latency-stage, token, cost, and redacted error
  detail. History can be cleared only through an explicit confirmation action.
- **The renderer never receives the loopback token.** Typed IPC and the
  main-process client validate every response before data reaches React, and the
  authenticated gateway strips its token before forwarding to the engine.
- **Verification:** the isolated authenticated-gateway proxy client test passes;
  the full suite passes 42 files and 327 tests; the packaged real-engine smoke
  creates a failed request through the proxy, verifies history and detail
  through IPC, and renders the activity screen with its detail inspector at
  1440x920 and 960x640. The packaged smoke also verifies that Brain, Proxy, and
  Settings content remain full-width at both sizes. Live SSE, replay, broader
  proxy configuration, and the remaining parity rows stay open.

**Files:** `apps/desktop/src/main/proxy-client.ts`,
`apps/desktop/src/renderer/src/components/ProxyView.tsx`,
`packages/contracts/src/proxy.ts`, `test/desktop-proxy.test.ts`

**Next:** continue the remaining proxy configuration/activity parity and Brain
maintenance/import-export controls, then close the remaining Phase 3 rows.

## 2026-09-12

### Cognitive1 execution rules

- **A Rules button now sits in the chat footer** beside Goal and Skills. It
  opens a full panel that loads the authoritative `Instruct.md` file from the
  Cognitive1 project, shows all 57 numbered rules, and supports searching,
  editing, and adding rules.
- **The rule source stays authoritative.** Edits are written directly back to
  `Instruct.md`; KAI does not create a second rule copy. Set
  `kai.executionRulesPath` when the file is not in a sibling `cognitive1`
  repository or `~/.kai/brain/Instruct.md`.
- **Enabled rules apply to every agent.** Normal tasks, handoffs, workflows,
  and comparisons all receive the full Cognitive1 standing instructions and
  session workflow as a prompt preamble.

**Files:** `src/cognitive1/rule-store.ts`,
`src/orchestrator/orchestrator.ts`, `src/orchestrator/plan-runner.ts`,
`src/panel/workbench-view-provider.ts`, `src/panel/workbench.js`,
`src/panel/workbench.css`, `src/extension.ts`, `package.json`

**Action needed:** Run `npm run compile` and reload the extension host.

### Codex-style Goal mode and Skills

- **Goal mode** now stores a durable goal per conversation with three explicit
  parts: outcome, constraints, and definition of done. Every goal-backed turn
  receives that contract, so follow-up prompts and resumed runs do not lose the
  original target.
- **The goal progress row sits above the composer** and supports pause/resume,
  mark complete, edit, and clear. `/goal` opens the editor, `/goal <outcome>`
  pre-fills it, and goals survive saving, reopening a conversation, and app
  restarts.
- **Skills are now first-class KAI context.** KAI discovers `SKILL.md`
  packages from ancestor and user `.agents/skills` directories, shows their
  names, descriptions, scope, and paths in a browser, and accepts `$skill`
  mentions or the `/skills` command. Selected skill instructions are injected
  into the prompt, so the behavior works with every configured agent rather
  than only Codex's native skill runner.
- **Codex-style command affordances** include a slash-command picker for
  `/goal` and `/skills`, `$` autocomplete from the composer, and a compact
  goal row with icon controls.

## 2026-09-11

### Phase 6 memory injection and a locked-down proxy (partial)

- **Relevant memory is now injected into every prompt.** Recall results are
  prepended as a `Relevant memory from past sessions:` briefing built by
  `buildMemoryBriefing()` in `src/core/prompt-builder.ts` — capped at 1500
  characters, and suppressed entirely when recall returns nothing or
  Cognitive1 is disabled, so the agent is never told "No recall results
  found." in place of real context.
- **KAI learns from each turn.** A completed run saves a memory entry via
  `learnFromTurn()`.
  - Caught by this work's own test: it was saving the *memory-augmented*
    prompt — the one KAI sends to the agent — as the memory title, so every
    new memory was just an echo of the last recall. It now uses the user's
    own prompt text.
- **The proxy is no longer an open door on localhost.** It holds your real
  upstream API key, so anything on the machine — or any web page whose
  `fetch()` reaches `127.0.0.1` — could previously ride it. Two locks now
  close that (`src/proxy/proxy-server.ts`):
  - A random token (`randomBytes(24)`, `src/config/proxy-token.ts`), written
    into `~/.claude/settings.json`'s `ANTHROPIC_AUTH_TOKEN` and required back
    on `/v1/messages` as `Authorization: Bearer <token>`.
    - Stored per installation rather than regenerated on each activation.
      KAI only rewrites that settings file just before a proxy-routed run, so
      a fresh window would leave a stale token behind and 401 any agent
      started another way (a `claude` typed into a terminal, say) until KAI
      happened to run one itself.
  - Any request carrying an `Origin` header gets 403 unconditionally —
    that header means a browser context, and no legitimate CLI HTTP client
    sends one. This lock applies even when no token is configured.
  - Both fall back to the previous unauthenticated behavior when no token is
    set, so nothing that worked before breaks. `test/proxy-auth.test.ts`
    (9 tests) runs a real proxy against a fake upstream that records every
    request it receives, so each unauthorized path is shown to return
    401/403 *and* to never have reached the upstream key at all;
    `test/proxy-token.test.ts` (6 tests) covers token persistence.
- **Still to do in this phase**, each as its own session and each starting
  with a short written spike reviewed before any coding: a real ACP JSON-RPC
  client for Qwen/Gemini (replacing the current parser-only adapter), and
  Claude interactive approvals. Codex and Qwen are also not yet covered by
  the proxy token — their config schema for carrying a matching token hasn't
  been verified against a live run.

### Phase 5 workflows and compare in real git worktrees

- **"Plan mode" renamed "Workflow"** in every user-facing label (button
  title, empty-state copy, placeholders) — Claude Code, Codex and Qwen
  Code all use "Plan" for a read-only planning mode, which is what KAI's
  own Phase 2 Plan permission mode now means too; keeping "Plan mode" for
  the multi-step runner would have meant two different things called Plan
  in the same app.
- **Workflow stepper redesign** — a vertical stepper (agent, step label,
  live time/cost, an italic handoff note between steps) replaces the flat
  list. A failed step gets Retry, Retry with ▾ (pick a different agent for
  just that retry — `PlanRunner.retryStep()` now takes an optional agent),
  an inline Edit prompt textarea (replacing a `window.prompt` dialog), and
  Skip.
- **Compare runs in real git worktrees** (`src/orchestrator/worktrees.ts`),
  not the live workspace — each agent gets its own `git worktree add`
  checkout, so neither can see or overwrite the other's edits, and nothing
  touches the user's files until they click "Pick this one" (which applies
  that side's patch via `git apply` and removes both worktrees) or
  "Discard both". "Open worktree" opens a side in a new VS Code window.
  This was previously disabled (Phase 0.8) because it ran both agents
  directly in the workspace at once.
  - Found and fixed a second real cross-platform bug while building this:
    on this machine's Windows git config, `git worktree add`'s checkout
    also silently converts LF to CRLF (the same class of bug Phase 3 fixed
    for checkpoint restores) — every worktree git call now runs with
    `-c core.autocrlf=false`, verified by this module's own tests against
    a real repo.
  - `renderCompareSummary()` — referenced since the original compare-mode
    commit but never implemented (dead code behind a `typeof === function`
    guard, so compare silently showed no summary) — is now implemented:
    per-side result card with elapsed time, file stats, and the actions
    above.

### Phase 4 conversations, multi-turn sessions, and a real Codex parser bug fix

- **Codex parser rewritten against real output.** Ran
  `codex exec --json --sandbox read-only "<prompt>"` for real and found the
  actual event shape (`thread.started`/`item.started`/`item.completed`/
  `turn.completed`) is nothing like what `codex-parser.ts` expected
  (`delta`/`tool_call`/flat `usage`) — every Codex reply, tool call, and
  cost update was silently falling through to `raw.fallback`. Rewritten and
  tested against the real captured session (see the parser's module doc);
  fixtures in `test/codex-parser.test.ts` are copied verbatim from that run.
- **Multi-turn sessions.** Claude's `session_id` (already captured in
  Phase 0) and Codex's new `thread_id` are now remembered per agent for the
  active conversation; a follow-up to the same agent passes `--resume`
  (Claude) / `exec resume` (Codex) instead of starting fresh each message.
  Verified live: asking "what did I just ask?" in a resumed session, for
  both agents, correctly answered from the prior turn.
- **Real handoff context.** A handoff prompt now carries the previous
  agent's actual last reply (capped at 2000 characters) and
  `git diff --stat`, not just the original prompt.
- **Conversation history** (`src/panel/conversation-store.ts`) — every
  turn's events persist to `globalStorageUri/conversations/*.json`. A
  History panel lists past conversations (search, per-agent dots, cost,
  relative time, an unread dot for ones that finished while KAI wasn't
  visible) with rename, fork, and archive; clicking one replays its
  transcript. "New chat" now actually starts a new conversation
  (`orchestrator.startNewConversation()` clears remembered sessions) rather
  than only clearing the visible transcript.

### Phase 3 checkpoints, diff review, and approvals

- **Checkpoints** (`src/orchestrator/checkpoints.ts`) — a `git stash create`
  snapshot taken at the start of every task, without touching the working
  tree. Restoring reads each changed file's exact checkpoint content via
  `git show` and writes it directly with `fs.writeFile`, rather than
  `git checkout` — a real bug this module's own tests caught: on this
  machine's Windows git config, `git checkout` silently re-introduces CRLF
  into an LF file on restore, corrupting it the same way Phase 0's
  diff-applier fix addressed for agent-proposed diffs.
- **Diff summary card** — when a turn ends (including at a handoff pause),
  the orchestrator diffs against the checkpoint and, if anything changed,
  shows "N files changed +A −R" with per-file stats and Review in editor /
  Keep all / Undo all.
- **Review in editor** opens each changed file in VS Code's real diff
  editor via a `kai-checkpoint:` read-only content provider; `KAI: Reject
  This File` reverts just that file from the editor title bar.
- **Rewind to here** — a button on each of your messages restores every
  file that turn touched back to its checkpoint, after confirmation.
- **Real approval cards** — Allow once / Always allow \<title\> / Deny,
  wired through a new `AgentAdapter.respondToApproval()` (optional — no
  current adapter can act on it yet, see Known limitations below) and an
  "always allow" rule set persisted per workspace.

### Phase 2 composer redesign

- **Permission modes** — replaced Review/Auto/Custom with five modes
  matching Claude Code's own: Plan (read-only), Ask before edits, Edit
  automatically, Full access, and Custom (a per-action checklist). Mapped
  to real, `--help`-verified flags: Claude's `--permission-mode`
  (`bypassPermissions` for Full also needs `--dangerously-skip-permissions`
  to take effect) and Codex's `--sandbox`. A stored `review`/`auto` value
  from an older KAI version migrates automatically.
- **New composer** — the three dropdowns are gone. A mode chip and an
  agent/route chip open rich menus (label + description; the agent menu
  shows a Direct/Proxy toggle, model name, and an "Install…" hint for an
  agent that isn't on PATH). Shift+Tab cycles the mode.
- **@ context menu** — search workspace files, add the current selection,
  attach `git diff --stat`, or search memory; each becomes a removable
  chip. An active-file chip tracks the editor and can be excluded without
  removing it. `KAI: Add Selection to Chat` (Alt+K, and in the editor's
  right-click menu) adds a selection chip from anywhere.
- **Prompt assembly** moved server-side into a pure, unit-tested
  `buildPromptWithContext()` (`src/core/prompt-builder.ts`) — one source of
  truth for the exact preamble shape sent to the agent.
- **Queue while running** — Enter during an active run queues the message
  (editable, removable) instead of doing nothing; it sends automatically
  once the run finishes. Ctrl+Shift+Enter stops the run and sends
  immediately ("steer now").
- **Context meter** — a ring in the composer shows the latest turn's input
  tokens against a per-agent/route context-window estimate.
- Paste or drop an image onto the composer to attach it (saved to the
  extension's global storage).

### Phase 1 chat redesign

Reworked how replies render in the Agent Workbench chat, following the
`docs/design/*.dc.html` reference screens.

- **Reply turns** — each reply is now a "turn": an agent-coloured dot and
  name, a route/model chip (e.g. "Proxy · DeepSeek V4 Pro (via proxy)"), a
  live cost chip, and an elapsed timer, instead of a generic bordered bubble.
- **Markdown rendering** (`src/panel/markdown.js`) — replies render fenced
  code blocks (with a language label and a working Copy button), inline
  code, bold/italic, headings, lists, and clickable links (opened via
  `vscode.env.openExternal`, never a raw `href`).
- **Grouped tool calls** — consecutive tool calls collapse into a single
  "Ran N tools" card with a per-tool tally, expandable to see each call.
- **Memory and thinking chips** — a successful recall shows as a "Used N
  memories" chip you can click to see the recall text; a `channel: 'summary'`
  text delta renders as a collapsible "Thought" chip.
- **Message actions** — Copy, Retry (resend the last prompt to the same
  agent), and Continue with ▾ (hand off to another agent, dimming ones the
  Settings capability check reports as unavailable).
- **Unavailable agents** are now greyed out in the agent picker with the
  reason as a tooltip, driven by the `capabilities` message the webview
  previously ignored.
- **Notifications** — a run that takes over 20 seconds, or an approval
  request, shows a VS Code notification with an Open button and an
  activity-bar badge when the KAI sidebar isn't visible; both clear when you
  open it.
- Replaced hard-coded hex colours in the plan-progress and compare-mode CSS
  with `--vscode-*`/`--kai-*` tokens so they track the active theme (Dark
  Modern, Light Modern, and High Contrast all checked).
- Added `getModelName()` to the cost estimator so the reply header and any
  future composer work share one source for per-agent/route model names.

### Phase 0 correctness fixes

- Preserved `/v1` in proxy base URLs while normalizing only Anthropic paths.
- Preserved multi-event parser output and buffered partial agent output lines.
- Passed prompts through stdin, including multiline prompts containing `%PATH%`.
- Restored Claude replies, costs, session IDs, and autonomy permission modes.
- Made diff application exact-match only with CRLF preservation and safe failure handling.
- Hid unfinished compare mode and excluded roadmap/design files from packaged extensions.

## 2026-07-06

### Self-contained proxy and embedded Cognitive1 (v0.3.0)

KAI no longer depends on external servers or scripts. The ClaudeCode-Proxy and
Cognitive1 features are now built directly into the extension.

- **Built-in proxy server** (`src/proxy/proxy-server.ts`) — Full HTTP proxy
  handling `/v1/responses` (Codex Responses API), `/v1/chat/completions`,
  `/v1/messages` (Anthropic Messages API). Translates Responses → Chat
  Completions for non-OpenAI targets (DeepSeek, Groq), with streaming SSE in
  both directions, model mapping, and DeepSeek reasoning round-tripping. Auto-starts
  on activation, reads config from `kai.proxy.*` settings with `claudeProxy.*`
  fallback.
- **API translator** (`src/proxy/translator.ts`, `src/proxy/types.ts`) —
  OpenAI ↔ Anthropic format translator ported from ClaudeCode-Proxy. Handles
  requests, responses, streaming, tool calls, and token estimation.
- **Embedded Cognitive1 default** — `createCognitive1Client` now defaults to
  `EmbeddedCognitive1` using `~/.kai/brain` (file-based JSONL + TF-IDF search).
  External HTTP client is opt-in via `kai.cognitive1Embedded: false`. Added
  `kai.cognitive1Embedded` setting (defaults `true`).
- **KAI-owned proxy settings** — Added `kai.proxy.*` settings to package.json
  (targetBaseUrl, apiKey, defaultModel, modelMap, codexConfig). Proxy reads from
  `kai.proxy.*` first, falls back to `claudeProxy.*`.
- **Codex TOML config** — `CodexConfigWriter.withProxyProfile` now saves original
  `model_provider`/`model` into an inline `[proxy.backup]` table. `restoreConfig`
  restores from that backup, uses `profileName` variable (not hardcoded), and
  detects managed configs by both KAI markers and bare table names (compatible
  with ClaudeCode-Proxy-written configs). Added `escapeRegex` helper.
## 2026-07-05 (later)

### Settings — Upstream Provider and Agent Routing always visible (v0.2.9)
The Proxy section (where you enter your DeepSeek API key for all agents) was
rendered entirely by JavaScript. If the async capabilities probe stalled or JS
failed silently, the user was stuck staring at "Loading proxy status…" with no
way to enter an upstream key. Same root cause as the agent-card blanking fixed
in v0.2.8.

- **Upstream Provider, Agent Routing, Proxy Server, and Provider Overrides are
  now pre-rendered as static HTML** — same pattern as the agent cards. The DeepSeek
  API key input, provider dropdown, model field, Route/Direct buttons, and endpoint
  display are all present in the DOM from the moment the page loads. No dependency
  on the async state message.
- **`renderStaticProxySection()`** method added to `SettingsViewProvider`. Reads
  the current `claudeProxy.*` config (upstream provider, routing toggles, proxy
  port/script) at HTML generation time and produces the full proxy section as static
  HTML, including preselected provider and current route badge states.
- **`renderProxy()` → `updateProxy()`** — the JS function no longer replaces
  `innerHTML`. It only patches dynamic indicators: proxy running/stopped badge,
  upstream key saved-state placeholder, endpoint URLs, and route badge labels.
  The form structure survives regardless of JS state.
- **"Loading proxy status…" placeholder removed** — the `<div id="proxy">` now
  contains `${staticProxy}` directly.


## 2026-07-05

### Auto-find free port for "Open in browser" (v0.2.9)
Port 8000 was hardcoded, so clicking the button a second time (or when something
else was already using that port) would fail with `os error 10048`.

- **Fix:** the button now probes for a free port with `net.createServer` bound to
  `127.0.0.1:0`, then passes the assigned port to `code serve-web`. No more port
  collision.
- Also extracted the serve-web launch into its own `launchServeWeb(port)` method
  for cleanliness.

### Settings pre-rendered + Open in Browser bypasses JS (v0.2.8)
Two structural fixes that make the Settings panel work regardless of whether the
async capability probe completes.

- **Agent cards are now pre-rendered in the HTML.** The `<div id="agents">` container
  is no longer empty — all four agent cards (Claude, Codex, Qwen, Gemini) are written
  server-side from the `AGENT_PROVIDERS` catalog before the webview loads. Every card
  has its text, tags, command input, and API-key input immediately visible. The async
  `state` message only updates the "installed"/"not installed" badge and key-status
  indicator — it never creates or replaces the cards.
- **"Open in browser" now uses a `command:` link** instead of relying on the webview
  JavaScript to `postMessage`. VS Code natively intercepts `<a href="command:kai.openBrowser">`
  clicks, so the button works even if the inline `<script>` is blocked by CSP or fails
  to execute. A new `kai.openBrowser` command is registered in package.json and wired
  to the `SettingsViewProvider.openInBrowser()` method.
- **Error banner** (`window.onerror`) retained from v0.2.7 — any future script failure
  shows a red bar instead of failing silently.

### Settings panel blank — API-key inputs missing, buttons dead (v0.2.7)
**This was the real cause of "buttons don't work / nothing displays."** The Settings
panel's agent cards (and the API-key inputs inside them) are rendered only after the
extension replies to the webview with agent capabilities. That reply could hang
forever, leaving the panel half-rendered and unresponsive.

- **Root cause:** `commandInfo()` probed each agent CLI with `<agent> --version` and
  had **no timeout** — it only resolved on the process's `close`/`error` event. If any
  of `claude`/`codex`/`qwen`/`gemini` existed on PATH but didn't cleanly exit on
  `--version` (e.g. a wrapper waiting on stdin, or an interactive prompt — common on
  Windows with `shell: true`), the probe never resolved. Because capabilities were
  gathered with `Promise.all`, that one hang blocked the whole set, so the Settings
  `state` message was never sent and the agent cards / key inputs never appeared.
- **Fixes:**
  - `commandInfo()` now has a hard **5s timeout** that kills the probe and reports the
    agent as unavailable, so it always resolves.
  - `getCapabilities()` resolves each adapter independently — one failing agent can no
    longer blank the panel.
  - Settings `postState()` falls back to catalog defaults if probing fails, so the
    cards always render.
  - Added a visible error banner (`window.onerror`) in the Settings webview so any
    future script failure is shown instead of failing silently.
- If the **Open in browser** button still does nothing, it's because `code serve-web`
  needs the `code` CLI on your PATH; the button now also passes
  `--accept-server-license-terms` so it won't stall on the first-run license prompt.

### Chat input field not showing / buttons unclickable (v0.2.6)
Fixed the chat composer (message input + Send button + template chips) being pushed
off the bottom of the sidebar and clipped out of view.

- **Root cause:** the scrollable `.chat` area was `flex: 1` with no `min-height: 0`.
  Because a flex item defaults to `min-height: auto`, `.chat` refused to shrink below
  its content height. In the KAI sidebar — where the Agent Workbench view shares
  vertical space with Settings, Engine Room, Memory and Sessions — the pane is short,
  so the un-shrinkable chat area shoved the composer below the visible edge. The input
  and its buttons were rendered but off-screen, so they appeared "missing" and
  couldn't be clicked.
- **Fix:** `.chat` is now `flex: 1 1 auto; min-height: 0` so it shrinks and scrolls
  internally, and `.composer` is `flex: 0 0 auto` so the input row stays pinned at the
  bottom and always visible. `.app` also gets `min-height: 0; overflow: hidden`.
- Tip: you can still drag the "Agent Workbench" section header taller, or use the
  **⤢ Tab** button to pop the chat into a full editor tab.

### Button & display audit fixes (v0.2.5)
Swept every panel button and made sure each has a working handler and that dependent
UI actually renders.

- **Engine Room — Config Backups now load on open.** The panel only requested the
  dashboard on `ready`/`refresh`; the backups list was never fetched unless an
  unrelated state change happened to fire a full refresh. It now loads backups
  alongside the dashboard, so the Refresh button and first open both populate it.
- **Settings — Provider Overrides honor the toggle.** The per-agent override fields
  rendered expanded even when "own backend" was off. They now start collapsed unless
  the override is enabled, and the toggle reads **"Use different provider for …"** to
  match the intended UX.
- **Settings — "Open in browser" no longer hangs on a blank tab.** `code serve-web`
  now runs with `--host 127.0.0.1 --accept-server-license-terms` so the first launch
  doesn't stall on the interactive license prompt before the browser opens.

### Unified proxy configuration in KAI (no more fragmentation)
All proxy/upstream provider settings now live in the **KAI → Settings** tab. You no
longer need to jump into raw VS Code `claudeProxy.*` settings.

- **Upstream Provider** section — set the base URL, API key, and default model for the
  shared upstream (e.g. DeepSeek). Includes a provider preset dropdown
  (DeepSeek OpenAI-compat, DeepSeek Anthropic pass-through, Groq, Moonshot, Together,
  Ollama, LM Studio, Anthropic direct) that auto-fills the URL + model.
- **Per-Agent Backends** — Codex and Qwen can each opt into their own upstream
  (base URL + key + model). When disabled, the agent shares the main upstream provider.
- **Agent Routing** — per-agent Route / Direct buttons plus Route All / Direct All.
  Route rewrites each agent's native config to point at `localhost:<port>`; Direct
  restores the original endpoint.
- **Restart proxy** button added to the Settings panel.
- KAI now reads/writes the same `claudeProxy.*` keys the proxy server consumes, so the
  proxy picks up changes on restart. New keys registered in `package.json`:
  `claudeProxy.targetBaseUrl`, `apiKey`, `apiKeys`, `defaultModel`, `modelMap`,
  `routeClaudeCode`, `routeCodex`, `codexConfig`, `qwenConfig`.

**Anthropic pass-through vs OpenAI-compat:** selecting a URL containing `/anthropic`
(e.g. `https://api.deepseek.com/anthropic`) makes the proxy forward requests natively
without format translation. A plain host (e.g. `https://api.deepseek.com`) triggers
Anthropic→OpenAI translation.



### Provider-first upstream: one key, auto-derived agent endpoints
The Upstream Provider now asks for exactly what matters — pick a provider, enter its
API key — and the proxy auto-routes each agent to the correct endpoint format.

- **Provider preset** now carries per-agent endpoint mappings (Claude → Anthropic
  pass-through, Codex/Qwen → OpenAI-compatible). Picking DeepSeek auto-derives
  https://api.deepseek.com/anthropic for Claude and https://api.deepseek.com
  for Codex/Qwen — no manual Base URL entry needed.
- **Agent endpoints display** shows the derived URLs per agent as read-only,
  with format badges (Anthropic / OpenAI).
- **Saving the upstream provider** now automatically writes the correct
  per-agent base URLs and shared API key to the Codex/Qwen config blocks.
- **Provider Overrides** section simplified — shows the current auto-derived
  endpoint, with the toggle now labeled "Use different provider" and custom
  fields tucked behind it. The override is only needed when switching to a
  completely different provider like real OpenAI.
- **Web UI button** fixed — uses --host 127.0.0.1 --accept-server-license-terms
  instead of the invalid --without-connection-token flag.
### Cleaner Settings: API keys collapsed, provider routing clarified
The Settings panel now reflects how you actually use KAI — agents normally sign in
directly, and the proxy handles per-agent format routing automatically.

- **Agent cards** — the API key field is now hidden behind a collapsed **Advanced**
  toggle. Since most users sign in through their agent account (Direct mode), the
  key field stays out of the way. Click to expand when you need Proxy-mode keys.
- **Upstream Provider** summary now explains that the proxy auto-routes each agent
  to the correct API format: Claude → Anthropic, Codex/Qwen → OpenAI-compat.
  No manual per-agent endpoint config needed when using the same provider.
- **Per-Agent Backends** renamed to **Provider Overrides** with a clear note that
  these are only for switching an agent to a completely different provider (e.g.
  real OpenAI for Codex). The proxy already handles same-provider format routing.
### Live "thinking" status indicator
The chat now shows an animated status line while an agent works behind the scenes —
a spinner, a rotating whimsical gerund (Thinking, Channelling, Conjuring, …), the
latest real activity (tool name / file being edited), and an elapsed timer. It appears
when a run starts and clears when the run finishes.

### Codex MCP recognized
The Codex adapter is now registered with `supportsMcp: true`, so KAI recognizes Codex's
MCP capability (parity with Claude). MCP servers are read from Codex's own
`~/.codex/config.toml` (`[mcp_servers.*]`); add them with `codex mcp add`. KAI's proxy
profile writer preserves existing `mcp_servers` tables when it manages the proxy config.
