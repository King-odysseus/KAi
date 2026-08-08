# KAI Agent Workbench

KAI is a self-contained VS Code multi-agent coding workbench. It combines a
built-in proxy server, embedded Cognitive1 memory, and real agent harnesses
(Claude Code, Codex, Qwen, Gemini) into one extension — no external servers or
scripts required.

## Architecture

- **Built-in proxy** (`src/proxy/proxy-server.ts`) — HTTP proxy handling
  `/v1/responses` (Codex), `/v1/chat/completions`, `/v1/messages` (Claude Code)
  with full API format translation (Responses ↔ Chat Completions, Anthropic ↔
  OpenAI), streaming SSE, model mapping, and DeepSeek reasoning round-tripping.
  Starts automatically on activation.
- **API translator** (`src/proxy/translator.ts`) — OpenAI ↔ Anthropic format
  translator covering requests, responses, streaming, tool calls, and token
  estimation. Shared by the built-in proxy and available for reuse.
- **Embedded Cognitive1** (`src/cognitive1/embedded-cognitive1.ts`) —
  File-based JSONL storage with TF-IDF ranked search. Defaults to
  `~/.kai/brain`. No external Cognitive1 server needed. Opt-in HTTP client
  available via `kai.cognitive1Embedded: false`.
- **Codex TOML config** (`src/config/codex-config.ts`) — Writes proxy profiles
  to `~/.codex/config.toml` with inline `[proxy.backup]` for clean
  restore when switching routes. Compatible with configs written by
  ClaudeCode-Proxy.
- **Claude Code config** (`src/config/claude-config.ts`) — Injects proxy env
  vars into `~/.claude/settings.json`.
- **Config backup** — All config writes create timestamped backups in
  `.kai-backups/`.

## Agents

| Agent   | Harness        | Routes        | Autonomy           |
|---------|---------------|---------------|--------------------|
| Claude  | Process       | direct, proxy | review, auto, custom |
| Codex   | Process       | direct, proxy | review, auto, custom |
| Qwen    | ACP           | direct, proxy | review, auto, custom |
| Gemini  | ACP           | direct, proxy | review, auto, custom |

## Settings

Proxy configuration lives under `kai.proxy.*` (KAI-owned) with `claudeProxy.*`
fallback for backward compatibility:

- `kai.proxy.targetBaseUrl` — upstream API base URL (default: DeepSeek)
- `kai.proxy.defaultModel` — fallback model when no mapping matches
- `kai.proxy.modelMap` — model name → upstream model mappings
- `kai.proxy.codexConfig` — per-agent Codex backend override
- `kai.proxy.qwenConfig` — per-agent Qwen backend override
- `kai.proxy.routeClaudeCode` / `kai.proxy.routeCodex` — per-agent routing flags
- `kai.cognitive1Embedded` — use embedded file-based C1 (default: true)

API keys are stored in the OS keychain via VS Code SecretStorage — never in
plaintext settings. The Settings panel handles secure key storage. Legacy
plaintext keys in `claudeProxy.*` are automatically migrated on activation.

## Commands

```powershell
npm install
npm run compile
npm test
```

After source changes: `npm run compile` then reload VS Code (`Ctrl+Shift+P` →
`Reload Window`). The compiled output is deployed directly to the installed
extension — no VSIX rebuild needed for dev iteration.

## PRD

See `KAI_AGENT_WORKBENCH_PRD.md`.