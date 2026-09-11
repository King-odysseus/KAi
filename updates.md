# KAI Agent Workbench — Updates

## 2026-09-11

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
