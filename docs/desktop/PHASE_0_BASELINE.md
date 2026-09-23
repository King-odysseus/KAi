# KAI Desktop Phase 0 Baseline

Recorded: 2026-09-23

## Repository state

| Repository | Branch | Commit | Worktree at audit time |
| --- | --- | --- | --- |
| KAI extension | `main` | current checkout | `DESKTOP_IMPLEMENTATION_PLAN.md` untracked; no tracked modifications |
| Cognitive1 | `master` | `51f6797740c16d1b3df5ddcb24393eb6197c2ce4` audited code baseline; later brain-sync commits do not alter engine code | Brain data and package/licence metadata are modified by the existing workflow; not reverted or overwritten |
| Universal Agent Proxy | `fix/streaming-usage-timeout` | `a8c2443dee3e9c8d268475fe6387cc25fd67a0bb` | clean before license metadata was added |

The two engine repositories are available as siblings of KAI:

```text
C:/Users/Mega-Mind/Documents/WebDev Projects/cognitive1
C:/Users/Mega-Mind/Documents/WebDev Projects/ClaudeCode-Proxy
```

## Current KAI baseline

Commands were run from the KAI repository on 2026-09-23.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run compile` | Pass | TypeScript completed with no output or errors |
| `npm test` | Pass | Initial audit: 37 files, 310 tests. After desktop contract/runtime tests: 39 files, 319 tests. |
| `npm run lint` | Existing failures | 396 errors and 29 warnings in 527 reported lines; not introduced by desktop work |

The lint baseline is broad and pre-existing. It includes strict-type and unsafe-value errors in the extension, webview, proxy, memory, parsers, and tests. Desktop work must not add desktop lint failures, but fixing the legacy lint backlog is a separate change from the desktop migration.

## Authoritative engine baselines

| Engine | Build/tests | Coverage signal |
| --- | --- | --- |
| Cognitive1 | `npm test`: 16 files, 315 tests passed | Brain parsing/writing, integrity, quality, MCP tool handlers, and the DeepSeek adapter |
| Universal Agent Proxy | `npm test`: 139 tests passed after TypeScript build | Routing, credentials, config transactions, translation, provider health, history, replay, streaming, cancellation, retries, and failover |

The merged KAI proxy and embedded memory remain useful compatibility code, but neither is accepted as proof of full-engine parity. The source repositories above are authoritative for Phase 3 integration.

## VS Code coupling inventory

Direct imports of `vscode` occur in:

| Area | Files |
| --- | --- |
| Extension activation | `src/extension.ts` |
| Logging | `src/core/logger.ts` |
| UI/webviews | `src/panel/*-view-provider.ts`, `src/panel/list-tab-panel.ts`, `src/panel/memory-tree-provider.ts`, `src/panel/raw-event-inspector.ts`, `src/panel/sessions-tree-provider.ts` |
| Settings and secrets | `src/config/project-preferences.ts`, `src/config/proxy-config.ts`, `src/config/secret-store.ts` |
| Diff application | `src/orchestrator/vscode-diff-applier.ts` |

Transitive coupling is more important than the direct import count. The extension activation creates workspace paths, settings, secret storage, output channels, tree views, webview panels, file watchers, and the VS Code diff provider, then passes those values into otherwise portable modules.

The first host seams are:

| Current dependency | Desktop port |
| --- | --- |
| `vscode.LogOutputChannel` | Structured logger sink writing redacted JSONL and an in-memory ring buffer |
| `vscode.WorkspaceConfiguration` | Validated app settings service with schema migration |
| `vscode.SecretStorage` | Electron `safeStorage` vault; fail closed if encryption is unavailable |
| `vscode.Memento` workspace state | Project preference records in atomic app storage |
| `vscode.WorkspaceEdit` diff application | Filesystem diff applier with project-boundary and dirty-file checks |
| Webview messaging | Validated typed IPC and versioned event envelopes |
| VS Code extension activation | Electron main process, preload bridge, and sandboxed renderer |

## Existing user data

| Data | Existing location/format | Desktop handling |
| --- | --- | --- |
| Embedded memory | `~/.kai/brain` JSONL/markdown | Import only through an explicit user action; keep original data untouched |
| Extension conversations | VS Code extension storage `conversations/*.json` | Add an explicit copy/import path; never read live extension state automatically |
| KAI settings | VS Code settings under `kai.*` | Migrate known safe values only with confirmation; secrets require separate secure handling |
| Proxy credentials | VS Code SecretStorage | Do not auto-import; require re-entry or an explicit migration action |
| Agent CLI configuration | `~/.codex`, `~/.claude`, `~/.qwen`, and related files | Do not modify during desktop startup; integrations must opt in |
| Cognitive1 engine data | Markdown under the configured wiki path; config under `~/.config/cognitive1/config.json` | Keep private data outside installation directories and back up before any migration |

## Phase 0 acceptance

- [x] Authoritative source repositories, commits, entry points, runtime dependencies, and licences recorded.
- [x] Source feature inventories started in `docs/desktop/FEATURE_PARITY.md`.
- [x] KAI compile, test, and lint baselines recorded without changing existing failures.
- [x] VS Code imports and host interfaces mapped.
- [x] Existing persisted formats identified with a no-implicit-import rule.
- [ ] Every unresolved source feature has final integration and test evidence. This remains open until Phase 3.

## Release blockers

1. Full Cognitive1 and Universal Agent Proxy parity remains unverified. Both engines now use PolyForm Noncommercial 1.0.0, but dependency redistribution notices still need a release-time inventory.
2. Universal Agent Proxy and Cognitive1 both include features beyond the current embedded KAI implementations. The parity register is the source of truth until those features are tested through the desktop services.
3. The legacy lint baseline has 396 errors. It is not a desktop release gate yet, but no new desktop package should copy this pattern or add to the backlog.
