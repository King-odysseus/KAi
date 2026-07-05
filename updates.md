# KAI Agent Workbench — Updates

## 2026-07-05

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
