# Spike 6.1 — a real ACP client for Qwen Code and Gemini CLI

Status: **findings + proposal, not yet implemented.** Stop for review before coding.

## Finding 1 — Qwen and Gemini runs are broken today

`AcpAgentAdapter` is constructed in `src/extension.ts` with no `acpArgs`, so it
defaults to `['--acp']` (acp-adapter.ts:41). That flag really does start an ACP
server — verified live on both CLIs.

But `--acp` speaks **JSON-RPC 2.0 over stdio**: it expects `initialize`, then
`session/new`, then `session/prompt`, and it never reads a plain-text prompt
from stdin. The adapter does the opposite — it pipes `request.prompt` to stdin
and treats stdout as a stream of unsolicited self-describing event lines. So
the handshake never happens.

Compounding it, the dedicated parsers don't match the wire format either.
`parseQwenJsonLine`'s doc comment calls its fields "Qwen Code ACP JSON-line
event shapes", but nothing on the real wire looks like `{type, delta, tool_name,
usage: {input_tokens}}`:

- real responses are `{"jsonrpc":"2.0","id":N,"result":{...}}`
- real events are notifications, `{"jsonrpc":"2.0","method":"session/update",
  "params":{"sessionId":...,"update":{"sessionUpdate":"..."}}}`

`session/update` carries no top-level `type`, so the parser misses the text
branch, the tool-call branch and the usage branch, and everything lands in
`raw.fallback`. **Qwen and Gemini replies, tool calls, diffs, approvals and
costs are currently discarded** — the same class of silent-drop bug as the
Codex parser fixed in Phase 4.

## Finding 2 — the protocol, as actually captured

`qwen --version` → 0.15.10; `gemini --version` → 0.49.0.

`initialize` → `result`:

```json
{"protocolVersion":1,
 "agentInfo":{"name":"qwen-code","title":"Qwen Code","version":"0.15.10"},
 "agentCapabilities":{"loadSession":true,
   "promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},
   "sessionCapabilities":{"list":{},"resume":{}},
   "mcpCapabilities":{"sse":true,"http":true}},
 "authMethods":[{"id":"openai",...},{"id":"qwen-oauth",...}]}
```

Gemini's is the same shape (no `sessionCapabilities`, plus a `gateway` auth
method). Note Gemini prints **plain-text diagnostics on stdout before its
JSON-RPC** ("Skipping project agents due to untrusted folder.", "Ripgrep is not
available. Falling back to GrepTool."), so the client must tolerate and route
non-JSON lines rather than choke on them.

`session/new` with `{"cwd": "/tmp", "mcpServers": []}` → `result`:

```json
{"sessionId":"2683655e-...",
 "models":{"currentModelId":"qwen-proxy(openai)","availableModels":[...]},
 "modes":{"currentModeId":"default","availableModes":[
   {"id":"plan","name":"Plan"},
   {"id":"default","name":"Default"},
   {"id":"auto-edit","name":"Auto Edit"},
   {"id":"yolo","name":"YOLO"}]},
 "configOptions":[{"id":"mode","type":"select","currentValue":"default","options":[...]},
                  {"id":"model","type":"select","currentValue":"...","options":[...]}]}
```

Then an `available_commands_update` notification arrives from `session/update`.

Two consequences worth noting:

- **The mode set lines up exactly with KAI's five autonomy modes**, and with the
  CLI's own `--approval-mode` choices (`plan|default|auto-edit|yolo`). Mapping:
  `plan→plan`, `ask→default`, `autoEdit→auto-edit`, `full→yolo`,
  `custom→default` (custom has no ACP equivalent, and default is the safe side
  of it). So the CLI-flag work done earlier and the ACP work agree on one mode
  vocabulary — no second concept to reconcile.
- `sessionId` is the resume key, and `loadSession: true` means resume is a
  first-class ACP operation rather than a CLI flag — parity with the
  `--resume <id>` support already added for Claude and Codex.

## Proposed design

A new `AcpClient` (in `src/adapters/acp-client.ts`) that owns the stdio
JSON-RPC conversation, with `AcpAgentAdapter` rewritten to drive it.

- **Framing.** Newline-delimited JSON-RPC on stdin/stdout. Increment an integer
  `id` per request; keep a `Map<id, {resolve, reject}>`. Non-JSON stdout lines
  and `stderr` become `raw.fallback` (Gemini makes this mandatory).
- **Startup.** spawn → `initialize` (do *not* advertise `fs.readTextFile` /
  `fs.writeTextFile` capabilities, so the agent uses its own tools and KAI's
  existing checkpoint/diff machinery keeps seeing real filesystem changes) →
  `session/new` with `{cwd, mcpServers: []}` → set the mode from KAI autonomy →
  `session/prompt` with the user's text.
- **Event mapping.** Dispatch on `params.update.sessionUpdate` in
  `session/update` notifications → `WorkbenchEvent`. Exact member names still
  to be confirmed by capture (see Open questions); the text/tool/plan members
  are the ones that matter.
- **Approvals.** Server→client request `session/request_permission` → the
  existing `approval.request` event and approval card; the reply is the
  existing `ApprovalResponse` (`once|always|deny`) mapped to ACP's option ids.
  This is the piece that finally makes "always allow" mean something for
  Qwen/Gemini.
- **Stop.** `session/cancel` notification, then abort the process if it doesn't
  wind down.
- **Resume.** `session/load` with the stored `sessionId`, reusing the
  `agentSessions` map the orchestrator already keeps.
- **Lifecycle.** One client per run for now, matching how adapters are used
  today; a persistent per-agent connection is a later optimisation.

## Risks / open questions

1. **`session/update` member names.** I verified the envelope and the
   `available_commands_update` member, not the assistant-text / tool-call /
   plan members. Confirming them requires one real prompt against each CLI
   (spends a little of the user's quota) — worth doing first, since the mapping
   is guesswork until then. This is the one thing that could change the design.
2. **Permission option ids.** The exact option id strings in
   `session/request_permission` need capturing before the reply mapping is real.
3. **Gemini's plain-text preamble** must be classified as noise, not shown as
   assistant text — falling into `raw.fallback` risks surfacing "Ripgrep is not
   available" as if the agent said it.
4. **Auth.** `authMethods` implies an unauthenticated agent answers
   `initialize` but then fails on `session/prompt`. Needs a clear error surfaced
   in the UI rather than a hang.

## Scope note

6.2 (Claude interactive approvals) is a separate spike and a separate session.
Codex/Qwen proxy-token coverage (deferred from 6.4) also still needs its own
look; that one is blocked on verifying whether their config schema can carry a
matching token at all.
