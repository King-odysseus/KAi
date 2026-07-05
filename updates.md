# KAI Agent Workbench — Updates

## 2026-07-05

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
