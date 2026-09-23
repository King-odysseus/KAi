# KAI Desktop Feature Parity Register

Updated: 2026-09-23

## Source identity

| Engine | Authoritative source | Version/commit | Licence | Entry points |
| --- | --- | --- | --- | --- |
| Cognitive1 | `C:/Users/Mega-Mind/Documents/WebDev Projects/cognitive1` (`King-odysseus/cognitive1`) | `1.0.0`, audited code commit `51f6797740c16d1b3df5ddcb24393eb6197c2ce4`; brain-only sync commits advanced HEAD during staging | PolyForm Noncommercial 1.0.0 | `out/index.js`, `out/cli.js`, `out/mcp/entry.js`, `out/mcp/http-entry.js` |
| Universal Agent Proxy | `C:/Users/Mega-Mind/Documents/WebDev Projects/ClaudeCode-Proxy` (`King-odysseus/Universal-Agent-Proxy`) | `1.9.0`, commit `a8c2443dee3e9c8d268475fe6387cc25fd67a0bb` | PolyForm Noncommercial 1.0.0 | `out/extension.js`, `src/proxy.ts` |

Status values:

- `Not started`: no desktop implementation.
- `Compatibility only`: a related but incomplete KAI implementation exists.
- `In progress`: adapter/service work has started.
- `Integrated`: desktop service/API evidence exists.
- `Verified`: integration and parity tests pass.
- `Blocked`: an external dependency, licence, runtime, or decision prevents completion.

No source-parity row was marked `Verified` at Phase 0. Current statuses are updated only as desktop service/API and UI evidence lands. Source tests are evidence about the engine, not proof that the desktop app exposes or packages the feature correctly.

## Cognitive1 MCP tool surface

The tool list is created in `src/mcp/tools/index.ts:172-223`. Each row is a required parity feature.

| Source feature | Source evidence | Desktop integration | UI/API exposure | Dependencies | Source test evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `brain_recall` | `src/mcp/tools/brain-recall.ts` | Managed C1 recall behind typed IPC; main normalizes and validates results | Brain search with query, type, project, and tag filters | BrainEngine, search index | `brain-recall.test.ts`; isolated desktop client test; packaged real-engine smoke | Verified |
| `brain_learn` | `src/mcp/tools/brain-learn.ts` | Persist accepted task knowledge | Brain learn plus task result action | BrainEngine, quality/dedupe | `brain-learn.test.ts` | Not started |
| `brain_status` | `src/mcp/tools/brain-status.ts` | Read managed service status and normalized Brain overview | Brain health | BrainEngine | `tools.test.ts` aggregate; packaged real-engine smoke | Verified |
| `brain_stats` | `src/mcp/tools/brain-stats.ts` | Read entry, quality, type, agent, and project summary metrics | Brain statistics | BrainEngine | Engine tests; packaged real-engine smoke | In progress |
| `brain_prune` | `src/mcp/tools/brain-prune.ts` | Explicit maintenance action | Brain maintenance | BrainEngine | No direct source test | Not started |
| `brain_handoff` | `src/mcp/tools/brain-handoff.ts` | Record structured handoffs on direct API agent switches and failed-run recovery through typed main-process calls | Handoff timeline and conversation memory events | BrainEngine | Client normalization test; isolated desktop client test | Integrated |
| `brain_review_suggestions` | `src/mcp/tools/brain-review-suggestions.ts` | Read suggestions | Brain review queue | BrainEngine | No direct source test | Not started |
| `session_start` | `src/mcp/tools/session-start.ts` | Start a C1 session lazily for each direct API conversation; update project claim without duplicating briefings | Task, memory timeline, and Brain activity | BrainEngine, briefing state | `session-start.test.ts`; client normalization test | Integrated |
| `session_end` | `src/mcp/tools/session-end.ts` | Close failed sessions and active sessions on conversation deletion or KAI shutdown; preserve C1 recovery handoffs | Conversation memory timeline and recovery state | BrainEngine | Engine tests; client normalization test | Integrated |
| `active_claim` | `src/mcp/tools/active-claim.ts` | Claim project work | Conflict indicator | BrainEngine | Existing KAI claim behavior | Not started |
| `active_release` | `src/mcp/tools/active-release.ts` | Release claim | Claim controls | BrainEngine | No direct source test | Not started |
| `active_list` | `src/mcp/tools/active-list.ts` | Read active work | Active work panel | BrainEngine | No direct source test | Not started |
| `urgent_set` | `src/mcp/tools/urgent-set.ts` | Set warning | Brain urgent banner | BrainEngine | `urgent-set.test.ts` | Not started |
| `urgent_clear` | `src/mcp/tools/urgent-clear.ts` | Clear warning | Brain urgent controls | BrainEngine | No direct source test | Not started |
| `urgent_list` | `src/mcp/tools/urgent-list.ts` | Read warnings | Brain urgent list | BrainEngine | No direct source test | Not started |
| `recall` cross-scope | `src/mcp/tools/recall.ts` | Search brain, daily logs, knowledge | Global search | BrainEngine, filesystem | No isolated source test | Not started |
| `wiki_status` | `src/mcp/tools/wiki-status.ts` | Read compliance/dashboard summary | Brain system status | BrainEngine, git | No direct source test | Not started |
| `project_init` | `src/mcp/tools/project-init.ts` | Preview then apply project bootstrap | Project setup | Git, templates, filesystem | `project-init.test.ts` | Not started |
| `compliance_audit` | `src/mcp/tools/compliance-audit.ts` | Read-only audit | Project diagnostics | Git, filesystem | No direct source test | Not started |
| `task_create` | `src/mcp/tools/task-create.ts` | Create durable task | Workflows/tasks | BrainEngine | `task-create.test.ts` | Not started |
| `task_list` | `src/mcp/tools/task-list.ts` | Read tasks | Workflows/tasks | BrainEngine | No direct source test | Not started |
| `task_claim` | `src/mcp/tools/task-claim.ts` | Claim task | Workflow assignment | BrainEngine | `task-claim.test.ts` | Not started |
| `task_complete` | `src/mcp/tools/task-complete.ts` | Complete task | Workflow completion | BrainEngine | Engine tests | Not started |
| `handoff_claim` | `src/mcp/tools/handoff-claim.ts` | Claim handoff | Handoff inbox | BrainEngine | No direct source test | Not started |
| `brain_ping` | `src/mcp/tools/brain-ping.ts` | Service readiness probe | Health status | BrainEngine | `tools.test.ts` aggregate | Not started |
| `conflict_check` | `src/mcp/tools/conflict-check.ts` | Detect overlapping claims | Conflict panel | BrainEngine | Engine tests | Not started |
| `task_route` | `src/mcp/tools/task-router.ts` | Route task to agent | Workflow routing | BrainEngine | No direct source test | Not started |
| `review_request` | `src/mcp/tools/review-request.ts` | Create review request | Review queue | BrainEngine | No direct source test | Not started |
| `review_list` | `src/mcp/tools/review-request.ts` | Read review queue | Review queue | BrainEngine | No direct source test | Not started |
| `regression_log` | `src/mcp/tools/regression-tracker.ts` | Record regression | Verification history | BrainEngine | No direct source test | Not started |
| `regression_report` | `src/mcp/tools/regression-tracker.ts` | Read regressions | Verification history | BrainEngine | No direct source test | Not started |
| `cost_log` | `src/mcp/tools/cost-tracker.ts` | Record usage/cost | Usage history | BrainEngine | No direct source test | Not started |
| `cost_report` | `src/mcp/tools/cost-tracker.ts` | Read usage/cost | Usage history | BrainEngine | No direct source test | Not started |
| `decision_log` | `src/mcp/tools/decision-log.ts` | Record decisions | Decision timeline | BrainEngine | No direct source test | Not started |
| `context_pack` | `src/mcp/tools/context-packager.ts` | Build bounded task context | Context inspector | BrainEngine | Engine tests | Not started |
| `compaction_check` | `src/mcp/tools/compaction-check.ts` | Detect context compaction need | Task context warning | BrainEngine | No direct source test | Not started |
| `recap_check` | `src/mcp/tools/recap-check.ts` | Require/record task recap | Recovery prompt | BrainEngine | No direct source test | Not started |
| `checkpoint` | `src/mcp/tools/checkpoint.ts` | Persist recovery checkpoint | Recovery timeline | BrainEngine | No direct source test | Not started |
| `recover` | `src/mcp/tools/recover.ts` | Recover interrupted work | Recovery view | BrainEngine | No direct source test | Not started |
| `brain_export` | `src/mcp/tools/brain-export.ts` | Export memory bundle | Brain export | Filesystem | No direct source test | Not started |
| `config_get` | `src/mcp/tools/config-tools.ts` | Read engine config | Settings diagnostics | Cognitive1 config | No direct source test | Not started |
| `config_set` | `src/mcp/tools/config-tools.ts` | Validated config write | Settings diagnostics | Cognitive1 config | No direct source test | Not started |
| `doctor` | `src/mcp/tools/doctor.ts` | Diagnose runtime | Diagnostics | Runtime environment | No direct source test | Not started |
| `git_status` | `src/mcp/tools/git-status.ts` | Read repository state | Project status | Git | No direct source test | Not started |
| `suggest` | `src/mcp/tools/suggest.ts` | Read workflow suggestions | Suggestion panel | BrainEngine | No direct source test | Not started |
| `notify` | `src/mcp/tools/notify.ts` | Broadcast event | Notifications | Event broadcast | No direct source test | Not started |
| `todo_project_create` | `src/mcp/tools/todo-project-create.ts` | Create project backlog | Projects/workflows | BrainEngine | No direct source test | Not started |
| `todo_project_list` | `src/mcp/tools/todo-project-list.ts` | Read project backlog | Projects/workflows | BrainEngine | No direct source test | Not started |
| `style_guide_extract` | `src/mcp/tools/style-guide-extract.ts` | Run local extraction | Design tools | Playwright | No direct source test | Not started |
| `brain_recall_feedback` | `src/mcp/tools/brain-recall-feedback.ts` | Record retrieval quality | Brain quality | BrainEngine | No direct source test | Not started |
| `crossref_bugs` | `src/mcp/tools/crossref-bugs.ts` | Cross-reference bugs | Brain quality | Overwatch | No direct source test | Not started |

## Cognitive1 runtime and interfaces

| Source feature | Source evidence | Desktop integration | UI/API exposure | Dependencies | Source test evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Markdown brain parser/index | `src/brain/index.ts`, `parser.ts` | Run in managed C1 process | Brain views | Node filesystem | 117 engine tests, parser/integrity tests | Compatibility only |
| Quality scoring and deduplication | `entry-quality.ts`, `dedupe.ts`, `quality-signal.ts` | Managed engine behavior plus read-only quality metrics in the Brain view | Brain quality | Brain files, stats JSON | `entry-quality.test.ts`; packaged real-engine smoke | In progress |
| Semantic search | `embeddings.ts` | Optional model/runtime provisioning | Brain recall | `@xenova/transformers` | No direct desktop parity test | Blocked on local runtime decision |
| Cross-reference resolution | `crossref-bugs.ts`, brain index | Preserve source behavior | Brain detail | Brain files | Engine tests | Not started |
| Auto-learn from git/errors | `auto-learn.ts`, git monitor | Explicit opt-in | Brain drafts | Git, BrainEngine | Engine tests | Not started |
| File watcher | `src/watchers/file-watcher.ts` | Supervise C1 service | Live brain updates | Chokidar | No direct source test | Not started |
| Git monitor | `src/watchers/git-monitor.ts` | Explicit project opt-in | Project activity | Git | No direct source test | Not started |
| Brain auto pull/push | `brain-sync.ts`, daemon timers | Explicit sync controls | Brain sync state | Git remotes | No direct source test | Not started |
| Scheduler | `src/scheduler/scheduler.ts` | Managed service timers | Brain schedule settings | `node-cron` | No direct source test | Not started |
| Daily logs and weekly summaries | `src/scheduler/jobs` | Preserve service jobs | Brain history | Filesystem | No direct source test | Not started |
| Prune check | `src/scheduler/jobs/prune-check.ts` | Preserve dry-run behavior | Brain maintenance | BrainEngine | No direct source test | Not started |
| Auto-tag job | `src/scheduler/jobs/auto-tag.ts` | Preserve service behavior | Brain maintenance | BrainEngine | No direct source test | Not started |
| Self-dev quality review | `src/scheduler/self-dev.ts` | Explicit settings and audit | Brain quality | BrainEngine | No direct source test | Not started |
| Overwatch classification/audit | `src/llm/overwatch.ts` | Optional provider credentials | Brain quality | Claude/DeepSeek API | DeepSeek adapter tests | Not started |
| Kernel distillation | `overwatch.ts` | Preserve source output path policy | Brain export | LLM, filesystem | No direct source test | Not started |
| Style guide crawler/extractor | `src/style-guide/` | Expose with explicit target and approval | Design tools | Playwright, network | No direct source test | Not started |
| MCP stdio transport | `src/mcp/entry.ts`, `server.ts` | Managed child endpoint for agents | Integrations | MCP SDK | `tools.test.ts` | Not started |
| MCP streamable HTTP transport | `src/mcp/http-entry.ts`, `src/http/server.ts` | Authenticated loopback endpoint | Integrations | MCP SDK, HTTP | No direct source test | Not started |
| REST API and SSE events | `src/http/server.ts:335-514` | Engine runs behind KAI authenticated loopback; broader API parity remains open | Brain/activity UI | HTTP, SSE, filesystem | Authenticated health smoke passes | In progress |
| Legacy dashboard | `dashboard/` | Not required in Electron UI; preserve API compatibility | Optional external client | Static web assets | None | Not started |
| Standalone React client | `standalone/` | Reuse screens/components selectively | Brain/system UI | React, Vite, daemon API | Isolated Brain client test; packaged real-engine smoke | In progress |
| Cognitive1 desktop shell | `desktop/main.cjs` | Reference implementation for service startup only | Not a KAI feature | Electron | No tests | Not started |
| Runtime configuration and env overrides | `src/config.ts` | Remap to app-owned settings while retaining service env contract | Settings/diagnostics | Filesystem, environment | No config tests | Not started |

## Universal Agent Proxy feature surface

| Source feature | Source evidence | Desktop integration | UI/API exposure | Dependencies | Source test evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Loopback HTTP proxy | `src/proxy.ts:220-530` | Managed service behind KAI authenticated loopback | Proxy status | Node HTTP | `proxy.test.ts`; packaged real-engine smoke | Integrated |
| HTTPS/TLS listener | `src/proxy.ts`, TLS config | Validated certificate paths | Proxy settings | Node HTTPS | No direct source test | Not started |
| Anthropic Messages API | `src/proxy.ts` endpoint handler | Preserve endpoint contract | Proxy endpoint | Anthropic types, HTTP | `translator.test.ts`, `proxy.test.ts` | Not started |
| OpenAI Chat Completions API | `src/proxy.ts:681` | Preserve endpoint contract | Proxy endpoint | OpenAI types, HTTP | `proxy.test.ts` | Not started |
| OpenAI Responses API for Codex | `src/proxy.ts:531` | Preserve endpoint contract | Proxy endpoint | Responses translation | `proxy.test.ts` | Not started |
| Streaming translation | `src/translator.ts` | Preserve streaming behavior in managed service | Activity/timeline | SSE | `translator.test.ts`, stream tests | Not started |
| Tool-call and tool-result translation | `translator.ts`, proxy request builders | Preserve source behavior | Activity detail | Provider dialects | Tool-call tests | Not started |
| Image block handling | `translator.ts`, proxy helpers | Preserve capability restrictions | Provider capability | Provider dialect | Image/tool tests | Not started |
| Token counting | `/v1/messages/count_tokens` | Proxy activity | Usage estimates | Upstream or estimator | Proxy tests | Not started |
| Model discovery | `/v1/models` | Populate available proxy models | Model selector | Configured model maps | Proxy tests | Not started |
| Dry-run translation | `/v1/dry-run` | Expose validated preview | Proxy diagnostics | Translation layer | Proxy tests | Not started |
| Health endpoint | `/health` | Private readiness check plus authenticated public endpoint | Health status | HTTP | Packaged real-engine smoke | Integrated |
| Connection test | `/v1/test` | Settings action | Connection status | Upstream credentials | Connectivity tests | Not started |
| Provider ping-all | `/v1/ping-all` | Diagnostics action | Provider health | Upstreams | Preset/routing tests | Not started |
| Named provider registry | `src/routing.ts`, `types.ts` | App-owned validated settings | Providers | URL/key store | `routing.test.ts` | Not started |
| Model-name routing | `routing.ts` | Preserve precedence rules | Routing profile | Provider registry | `routing.test.ts` | Not started |
| Agent pins | `routing.ts`, tagged paths | Preserve agent identity | Routing profile | Agent tags | `routing.test.ts` | Not started |
| Agent-tagged loopback paths | `parseAgentPath` in `routing.ts` | Generate per-agent endpoints | Integration details | CLI configuration | `routing.test.ts` | Not started |
| Legacy per-agent backends | `kimiConfig`, `qwenConfig`, `codexConfig` | Import explicitly only | Routing profile | Credentials, agent configs | Adapter tests | Compatibility only |
| Fallback providers | `fallbackProviders`, proxy request path | Preserve retry semantics and side-effect caution | Provider routing | Provider registry | Fallback tests | Not started |
| Retry with exponential backoff | proxy retry config | Direct provider requests retry transient connection and HTTP failures with bounded exponential delay and `Retry-After`; attempts persist as lifecycle events | Conversation activity | Upstream responses | Desktop direct-provider retry tests | Integrated |
| Provider circuit breaker | `observability/health-tracker.ts` | Preserve closed/open/half-open state; normalize reachability, success rate, errors, and latency through typed IPC | Provider health | Metrics window | `health-tracker.test.ts`; isolated desktop proxy client test | Integrated |
| Request/response history | `observability/history-store.ts` | Bounded redacted storage; typed search, pagination, detail inspection, and explicit clear | Proxy history | JSONL | `history-store.test.ts`; isolated desktop proxy client test; packaged real-engine smoke | Verified |
| Live history SSE | `/v1/history/live` | Authenticated app event stream | Proxy activity | SSE | Proxy tests | Not started |
| Replay preview and explicit run | `/v1/history/replay` | Require confirmation; never auto-replay | History detail | Persisted request body | Proxy replay tests | Not started |
| Cost tracking | `/v1/costs`, `/v1/costs/clear` | Read and display measured estimates through typed IPC | Proxy usage metrics and model list | Model price catalogue | Proxy tests; isolated desktop proxy client test; packaged real-engine smoke | Integrated |
| Cost budgets | proxy budget config | Warn or block according to source behavior | Budget settings | Usage ledger | Budget tests | Not started |
| Latency metrics | `/v1/metrics` | Read and display service metrics through typed IPC | Provider health and highest P95 | Sliding window | Proxy tests; isolated desktop proxy client test; packaged real-engine smoke | Integrated |
| Persistent JSONL request logs | logging config | App-owned bounded logs with rotation | Diagnostics | Filesystem | History/log tests | Not started |
| Request concurrency limit | `maxConcurrentRequests` | Preserve 503 behavior | Proxy settings | HTTP service | Proxy tests | Not started |
| Request rate limit | token-bucket config | Preserve 429 behavior | Proxy settings | HTTP service | Proxy tests | Not started |
| Upstream timeout | `upstreamTimeoutMs` | Preserve request cancellation | Proxy settings | HTTP | Timeout tests | Not started |
| Stall timeout | `stallTimeoutMs` | Preserve cancellation and 504 | Proxy settings | SSE | Stall tests | Not started |
| Custom upstream headers | `customHeaders` | Validated allowlist; redact secrets | Provider settings | HTTP | Proxy tests | Not started |
| Loopback host validation | `isLoopbackHost` | KAI gateway rejects non-loopback Host headers; engine remains pinned to `127.0.0.1` | Security diagnostics | HTTP | Integration gateway test; packaged real-engine smoke | Integrated |
| Credential vault | `credentials.ts` | Map to OS-backed desktop vault | Provider credentials | Secret storage | `credentials.test.ts` | Not started |
| Route configuration writers | `routing/adapters/*` | Opt-in only; never modify agent config on startup | Agent integrations | Agent config files | Adapter/config tests | Not started |
| Transactional route changes | `routing/routing-transaction.ts` | Preserve backup/rollback | Agent routing | Filesystem | `routing-transaction.test.ts` | Not started |
| Route verification | `routing/route-verifier.ts` | Expose diagnostics | Agent routing | Configs, loopback probe | `route-verifier.test.ts` | Not started |
| Config backup/restore | `routing/config-backup.ts` | App-owned backup metadata | Agent diagnostics | Filesystem | `config-backup.test.ts` | Not started |
| Auto fallback on usage limit | extension/dashboard logic | Explicit opt-in; never silently switch to paid API | Agent routing | Claude logs, provider creds | Direct routing tests only | Not started |
| Routing profiles and presets | `presets.ts` | Reuse versioned data; keep credentials separate | Provider setup | Provider registry | `presets.test.ts` | Not started |
| Universal Agent Proxy sidebar/dashboard | `sidebar.ts`, `webview.ts`, `dashboard.html` | Native activity, metrics, provider health, history, and detail screen implemented; broader dashboard parity remains open | Proxy UI | VS Code webview reference only | Packaged real-engine UI smoke at 1440x920 and 960x640 | In progress |

## VS Code extension command and workbench parity

The desktop app reproduces the extension's user-facing command and workbench
surfaces with native Electron controls. The palette is available from the title
bar Search button or `Ctrl+K`; it includes navigation, goal/skills/rules, agent,
route, autonomy, handoff, checkpoint, raw-event, proxy, workflow, history, backup,
and service actions. The packaged smoke checks opening the palette, filtering to
Execution Rules, navigating to the Rules view, and returning to the Workbench.

| VS Code extension surface | Desktop equivalent | Verification | Status |
| --- | --- | --- | --- |
| Open Agent Workbench | Workspace navigation item and command palette | Packaged UI smoke | Verified |
| Open Settings | Settings navigation item and command palette | Packaged UI smoke | Verified |
| Open Engine Room | C1 Brain and Universal Proxy service pages, plus Settings diagnostics | Service UI and real-engine smoke | Integrated |
| Open Memory | C1 Brain navigation item | Brain flow smoke | Verified |
| Open Sessions | History navigation item with search, rename, archive, fork, and delete | Responsive UI and type checks | Integrated |
| Open Chat in Editor | Workspace conversation view | Desktop-native equivalent | Integrated |
| Start or Edit Goal | Composer goal button, `/goal`, and command palette | Focused UI implementation | Integrated |
| Browse Skills | Composer `$` picker and command palette | Focused UI implementation | Integrated |
| View and Edit Execution Rules | Rules navigation item and command palette | Packaged command-palette smoke | Verified |
| Set Agent | Agent menu plus one command per discovered agent | Packaged menu smoke and agent capability tests | Verified |
| Set Route | Direct/Proxy route menu plus palette commands | Direct-provider and proxy UI tests | Verified |
| Toggle Route | Command palette direct/proxy toggle | Focused UI implementation | Integrated |
| Set Autonomy | Autonomy menu plus command per mode | Packaged menu smoke | Verified |
| Cycle Autonomy | `Shift+Tab` and command palette | Packaged menu smoke and keyboard handler | Verified |
| Handoff | `/handoff <agent>` and command palette handoff prompt | Focused UI implementation | Integrated |
| Show Proxy Status | Universal Proxy page status, health, and activity | Real-engine proxy smoke | Verified |
| Restart Proxy | Universal Proxy Restart and command palette action | Service control tests and real-engine smoke | Integrated |
| List/Restore Configuration Backups | Settings backup list, create, restore, and delete actions | Desktop backup tests and packaged UI smoke | Verified |
| Inspect Raw Events | Raw status button and command palette inspector, bounded to the latest 50 events | Focused UI implementation | Integrated |
| Add Selection to Chat | Context picker selection chip and palette action | Focused UI implementation | Integrated |
| Reject Checkpoint File | Checkpoint review per-file Restore action | Desktop checkpoint flow and focused tests | Integrated |
| Open in Browser | Not applicable to the native Electron shell; VS Code's local `serve-web` session is host-specific. Desktop exposes service endpoints, tokens, diagnostics, and controls in-app. | Architecture decision documented | Not applicable |

Selection context is deliberately desktop-native. VS Code can read the active
editor selection directly; Electron has no editor window, so the context picker
asks for a project-relative file and line range and sends the same bounded
`selection` context chip to the agent runtime.

## Requested desktop additions that are not source-parity features

These are explicit product additions. They must not be presented as parity work.

| Addition | Required evidence | Status |
| --- | --- | --- |
| Direct API agent without a CLI | Streamed tool loop, cancellation, provider-error tests | In progress: OpenAI Responses API, bounded project tools, approvals, stdio/Streamable HTTP MCP, scoped C1 recall, session/handoff recording, context estimates, and bounded retry/rate-limit recovery are implemented; additional providers remain open |
| Codex App Server account sign-in | Official runtime integration, mocked auth states, live opt-in smoke test | Not started |
| Claude Code account sign-in | Official runtime flow, credential separation, mocked and live tests | Not started |
| Native file/code/diff workspace | Project-boundary, CRLF, binary, symlink, dirty-file tests | Not started |
| Verification attached to file revision | Stale-check fixtures and passing repair rerun | Not started |
| Desktop workflows/budgets/recovery | Restart, interruption, pause/resume, budget-boundary tests | Not started |
| Windows installer and signed release | Clean-machine install and update/restore evidence | Not started |
| Authenticated loopback access and token rotation | Vault-backed token, 401/200 tests, old-token rejection after rotation | Verified |
| Native Brain search, inspection, and field editing | Typed IPC/client tests, real-engine smoke, responsive UI screenshots | Verified |

## Release blockers and unresolved decisions

1. Phase 3 must exercise every source row through the packaged desktop services. Source tests alone do not close parity rows.
2. The optional embedding model download and Playwright browser runtime need explicit packaging/on-demand decisions.
3. Existing KAI localStorage, VS Code storage, and engine files must be imported only through explicit user actions.
4. Agent route writers must remain opt-in. KAI must not modify `~/.codex`, `~/.claude`, or other agent configuration during normal desktop startup.
5. Subscriptions and billable API/proxy routes remain separate. No silent cross-route fallback is permitted.
6. PolyForm Noncommercial 1.0.0 now applies to KAI and both engines. Third-party dependency notices and any future public installer terms still require release review.
7. Crash restart policy, occupied-port recovery beyond clear failure, Brain import/export and remaining maintenance controls, remaining proxy configuration/activity parity, and the remaining parity rows are still Phase 3 release blockers.
