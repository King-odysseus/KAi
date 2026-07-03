# KAI Agent Workbench

KAI is a VS Code extension that will combine ClaudeCode-Proxy, Cognitive1, and
real agent harnesses into one multi-agent coding workbench.

Current implementation status: Phase 0 / early Phase 1 scaffold.

## Current Adapter Status

- Cognitive1 HTTP bridge: wired to `http://127.0.0.1:9876` by default.
- Codex: process-backed via `codex exec --json`.
- Claude: process-backed command slot exists, but this machine does not currently
  have `claude` on PATH.
- Qwen/Gemini: visible as scaffolded adapters only.

Review mode maps Codex to `--sandbox read-only`. Auto mode maps Codex to
`--sandbox workspace-write`.

The Workbench Stop button aborts active process-backed runs and records a
stopped lifecycle event in the timeline.

## Commands

```powershell
npm install
npm run compile
npm test
```

## PRD

See `KAI_AGENT_WORKBENCH_PRD.md`.
