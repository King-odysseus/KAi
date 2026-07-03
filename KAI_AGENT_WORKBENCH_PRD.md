# PRD: KAI Agent Workbench

## Summary

KAI Agent Workbench is a single VS Code extension that combines three existing
directions into one usable coding environment:

1. ClaudeCode-Proxy: model routing, Direct/Proxy switching, provider translation,
   and cost visibility.
2. Cognitive1: durable cross-agent memory, sessions, handoffs, recalls, and
   project knowledge.
3. A new unified agent workbench UI: one chat/task surface that can drive real
   agent harnesses for Claude, Codex, Qwen Code, and Gemini CLI.

The product promise is:

> Cursor gives you one agent locked to their models. KAI gives you multiple real
> agents, any route, and a memory that outlives all of them.

This PRD expands the 2026-07-02 Cognitive1 todo plan into an implementation-ready
product definition with scope, user workflows, feature suggestions, acceptance
criteria, risks, and phased delivery.

## Background

The current ecosystem has powerful parts, but they are split:

- ClaudeCode-Proxy already supports localhost API translation, DeepSeek routing,
  per-agent Direct/Route modes, and a dashboard.
- Cognitive1 already provides a brain, MCP tools, recall, handoff, sessions,
  cost tracking, and project knowledge.
- Claude, Codex, Qwen Code, and Gemini CLI each have different strengths, but
  users have to operate them separately.
- Multiple agents can accidentally spawn separate Cognitive1 instances or edit
  the same project without shared coordination.
- Agent settings live in separate global config files, creating setup friction
  and risk of accidental config corruption.

The approved direction is not to build a homemade agent loop. KAI should drive
the real native agent harnesses and normalize their outputs into one workbench.

## Vision

KAI is a multi-agent coding cockpit inside VS Code:

- One prompt box.
- One timeline.
- One active agent at a time.
- One durable memory.
- Two clear dials:
  - Agent: who works on the task.
  - Route: what model path they use, Direct or Proxy.

The user should feel like they are directing a team of specialists without
managing four separate terminals, four separate memory contexts, or four sets of
fragile configs.

## Goals

- Ship one VSIX that installs the workbench, proxy, and embedded Cognitive1
  runtime.
- Use real agent harnesses:
  - Claude via Claude Agent SDK in a worker thread.
  - Codex via app-server/headless JSON mode.
  - Qwen Code and Gemini CLI via ACP.
- Keep agents provider-neutral at the orchestration layer.
- Expose a unified event model for text deltas, tool calls, approvals, diffs,
  errors, costs, and handoffs.
- Run one active agent at a time to avoid memory pressure and edit collisions.
- Provide one live Cognitive1 brain instance per workbench session.
- Preserve standalone CLI usage and never overwrite user configs destructively.
- Make route/cost state visible enough that the user always knows whether work
  is using native subscription or proxy/DeepSeek.

## Non-Goals

- Do not build a generic raw LLM chat wrapper as the main agent engine.
- Do not replace Claude Code, Codex, Qwen Code, or Gemini CLI internals.
- Do not write memories into the extension install folder.
- Do not require a VSCodium fork for MVP.
- Do not run multiple editing agents concurrently in the same workspace.
- Do not silently mutate global agent configs without backup and diff visibility.
- Do not drop unknown agent events just because the unified renderer does not
  fully understand them.

## Target Users

- Solo developer using multiple AI subscriptions and proxy routes.
- Power user who wants Claude, Codex, Qwen, and Gemini available from one place.
- Multi-project developer who relies on Cognitive1 for memory and handoff.
- Cost-conscious builder who wants premium Direct routes when available and
  cheaper proxy routes when appropriate.
- Agent workflow tinkerer who wants visibility into sessions, costs, tools, and
  memory rather than a black box.

## Core Product Principles

- Native intelligence first: use each agent's real harness.
- One brain, many agents: context follows the task, not the tool.
- Explicit routing: Direct vs Proxy is visible and controllable.
- Config safety: backup, merge, and show what changed.
- Event honesty: unknown events render as raw text instead of disappearing.
- Collision avoidance: one active editing agent by default.
- Autonomy by choice: users can switch between approval-first work and Auto Mode
  where trusted agents can make edits directly.
- Extension first: fork VS Code only after proven extension limits are hit.

## Key User Workflows

### First Launch

1. User installs the KAI VSIX.
2. Extension activates and reads KAI settings.
3. KAI starts the proxy runtime.
4. KAI starts Cognitive1 in a worker thread with an external brain folder.
5. KAI checks for available agent binaries or SDK dependencies.
6. KAI backs up and merges config entries for supported agents.
7. Status bar shows agent, route, proxy, and C1 health.
8. Workbench opens with a ready state and setup warnings, if any.

### Starting A Task

1. User enters a prompt in the Workbench panel.
2. User chooses an agent from the header or slash command.
3. User chooses Direct or Proxy route from the route badge.
4. Orchestrator starts/continues a Cognitive1 session.
5. Orchestrator runs recall/briefing and packages context.
6. Active agent streams text, tool calls, approvals, diffs, and errors.
7. Timeline records the task, cost, model route, and memory events.

### Handoff

1. User types `/handoff codex` or selects another agent.
2. Current agent is paused or ended cleanly.
3. Orchestrator writes a Cognitive1 handoff.
4. Incoming agent receives session_start plus handoff summary.
5. Timeline continues under the same task context.

### Route Switching

1. User clicks route badge or types `/route proxy`.
2. KAI updates session route state for the selected agent.
3. ConfigWriter applies safe config changes if that agent needs config injection.
4. Header and timeline show the active route.
5. Cost tracking uses the route state for reporting.

### Reviewing Changes

1. Agent proposes file edits.
2. Workbench renders diff cards.
3. User approves, rejects, or opens the diff in VS Code.
4. Approved edits apply through VS Code workspace APIs where possible, preserving
   undo behavior.

### Auto Mode

1. User enables Auto Mode for the current task, project, or trusted agent.
2. KAI shows the active autonomy level in the Workbench header.
3. Agent can read files, run safe commands, and apply edits without per-edit
   approval, similar to Claude Code and Codex autonomous editing flows.
4. KAI still records every file edit, command, route change, and memory event in
   the session timeline.
5. Risky actions still require explicit approval unless the user has separately
   enabled the matching permission.
6. User can pause, stop, or roll back the task from the timeline.

## Product Surface

### Agent Workbench

Primary activity bar view.

Required:

- Chat/task timeline.
- Agent picker.
- Route badge: Direct or Proxy.
- Autonomy mode control: Review, Auto, and Custom.
- Current model/route/cost indicator.
- Tool call cards.
- Approval cards.
- Diff cards.
- Error cards with retry/diagnostic affordances.
- Slash commands:
  - `/agent`
  - `/route`
  - `/handoff`
  - `/memory`
  - `/sessions`
  - `/cost`

Suggested improvements:

- Task title auto-generation after first response.
- Pin important messages to session summary.
- "Open current task folder" and "copy handoff summary" actions.
- Compact timeline mode for long coding sessions.
- Per-message source tags: user, agent, tool, C1, system.
- Auto Mode activity rail showing files changed, commands run, tests attempted,
  and rollback points.

### Engine Room

Reuses and evolves the existing ClaudeCode-Proxy dashboard.

Required:

- Proxy server status.
- Default upstream model settings.
- Per-agent route toggles.
- API key/provider health checks.
- Spend/cost summary.
- ConfigWriter audit results.

Suggested improvements:

- Config diff preview before applying changes.
- "Restore previous config backup" button.
- Route test button per agent.
- Warning when a legacy/deprecated model is configured.

### Memory

Cognitive1 browser inside KAI.

Required:

- Current briefing.
- Recall search.
- Active project knowledge.
- Handoffs.
- Recent learned patterns/bugs/gotchas.
- Cross-agent session search.

Suggested improvements:

- Memory citations in chat timeline.
- "Save this as memory" from selected chat text.
- Noise/duplicate warning before saving memory.
- Per-project memory health card.

### Sessions

Read-only session and cost history for MVP.

Required:

- Past tasks.
- Agent used.
- Route used.
- Model/provider.
- Cost and token estimate where available.
- Linked handoffs.

Suggested improvements:

- Filter by project, agent, route, and date.
- Compare Direct vs Proxy cost for a task.
- Export session summary to markdown.

## Functional Requirements

### Orchestrator

- Maintains one active agent at a time.
- Queues or pauses other agents.
- Owns task state, selected agent, selected route, and current project context.
- Owns autonomy state: Review, Auto, or Custom.
- Calls Cognitive1 session_start at task start.
- Calls Cognitive1 recall before agent dispatch.
- Writes handoffs when switching agents.
- Integrates active_claim-style conflict checks before edit-heavy work.
- Emits unified events to the panel.

Acceptance criteria:

- Two agents cannot edit the same workspace concurrently through KAI.
- Handoff preserves task context and appears in Memory/Sessions.
- Unknown adapter events are preserved as raw text events.
- Auto Mode allows direct edits without per-edit approval, while still logging
  the exact edit stream and preserving stop/rollback controls.

### Autonomy and Permissions

KAI should support three autonomy modes:

- Review: default approval-first mode. File edits, shell commands, dependency
  installs, and config writes are proposed before execution.
- Auto: trusted coding mode. Agents may apply workspace edits and run normal
  project commands without per-step approval.
- Custom: user-defined permission profile for specific actions such as tests,
  package installs, git operations, config writes, network calls, or destructive
  filesystem changes.

Auto Mode requirements:

- Auto Mode must be visible in the header at all times.
- Auto Mode can be scoped to one task, one workspace, one agent, or a saved user
  preference.
- Every edit and command must appear in the timeline.
- KAI should create lightweight rollback/checkpoint records before large edit
  batches.
- Destructive actions remain gated unless explicitly allowed in Custom mode.
- Git commit/push actions require explicit approval by default.
- ConfigWriter changes require either explicit approval or a saved trusted
  permission for config writes.
- Agent adapters should expose their native autonomy capabilities so KAI can
  align with Claude/Codex-style editing rather than fighting the underlying
  tool.

Acceptance criteria:

- A user can enable Auto Mode and have Claude or Codex complete a normal edit
  task without approving every file change.
- The same task in Review mode produces approval cards before edits are applied.
- The timeline clearly shows what happened during Auto Mode.
- User can stop an Auto Mode run quickly.
- Risky operations are still blocked or escalated according to the active
  permission profile.

### Unified Event Model

Event types:

- Text delta.
- Thought/summary text where the agent exposes it.
- Tool call start/update/result.
- Approval request.
- Diff proposal.
- File edit applied.
- Autonomy mode changed.
- Permission escalation requested.
- Error.
- Cost update.
- Memory event.
- Route change.
- Agent lifecycle event.
- Raw fallback event.

Acceptance criteria:

- Claude, Codex, and ACP events can be snapshot-tested into the same model.
- Unknown event shapes render visibly instead of being dropped.
- UI can consume events without adapter-specific branches in most cases.

### Adapter Capability Handshake

Each adapter reports:

- Agent id and display name.
- Availability and version.
- Supported input modes.
- Supported event types.
- Tool support.
- Approval support.
- Diff/edit support.
- Context limits where known.
- Route support.
- Required config entries.

Acceptance criteria:

- Workbench disables unavailable agents with a useful reason.
- Orchestrator does not dispatch unsupported actions blindly.
- Capability changes appear after binary or config updates.

### Claude Adapter

Required:

- Runs via Claude Agent SDK in a worker thread.
- Supports Direct mode through native subscription/auth.
- Supports Proxy mode through ClaudeCode-Proxy base URL.
- Streams into unified events.
- Accepts MCP/Cognitive1 endpoint from orchestrator.
- Supports Review and Auto autonomy modes where the Claude Agent SDK exposes
  equivalent permission behavior.

Suggested improvements:

- Detect subscription exhaustion hints and offer route fallback.
- Surface native Claude tool approvals as Workbench approval cards.

### Codex Adapter

Required:

- Runs Codex through app-server/headless JSON mode.
- Supports config injection for proxy provider and C1 MCP.
- Uses `gpt-5.5` as the Codex placeholder/config model when proxy routing is
  active, per the 2026-07-02 decision.
- Streams structured output into unified events.
- Supports Codex-style autonomous editing in Auto Mode.

Suggested improvements:

- Detect stale config and show one-click repair.
- Support a "dry run adapter test" that starts Codex, asks for version/health,
  and exits without editing files.

### ACP Adapter

Required:

- One ACP client lights up Qwen Code and Gemini CLI where available.
- Capability handshake distinguishes Qwen vs Gemini behavior.
- Unified event fallback for ACP event divergence.

Suggested improvements:

- Per-agent install help when binary is missing.
- ACP transcript capture for debugging adapter edge cases.

### Embedded Cognitive1

Required:

- C1 runs as one live instance in a worker thread or child process.
- Brain data folder is external and configurable.
- Extension ships code, not private memory.
- Exposes local HTTP/SSE MCP endpoint.
- Provides stdio relay shim for agents that only support stdio MCP.
- Background git pull on activation and push after turns if configured.

Acceptance criteria:

- Multiple agents use the same C1 instance during a KAI session.
- Brain refreshes do not block the VS Code extension host UI.
- Memory folder can be changed without reinstalling the extension.

### ConfigWriter

Required:

- Backs up existing config files before writing.
- Merges KAI entries rather than overwriting whole files.
- Preserves custom user settings.
- Records what changed.
- Supports Codex config, Qwen/Gemini settings, and proxy route settings.
- Leaves standalone CLIs usable.

Acceptance criteria:

- Tests prove custom config entries survive KAI activation.
- User can locate backup files from Engine Room.
- Config merge conflicts produce warnings, not silent corruption.

### Proxy Integration

Required:

- Starts/stops proxy runtime from extension.
- Surfaces route state in Workbench header.
- Reuses existing per-agent Direct/Proxy flags.
- Tracks per-agent and per-session costs.
- Supports DeepSeek V4 defaults from current proxy decisions:
  - Main proxy default: `deepseek-v4-pro`.
  - Codex proxy preset: `deepseek-v4-flash` where speed/cost is preferred.

Suggested improvements:

- Cost projection before running a long task.
- Route policy presets: cheapest, balanced, premium first.
- Per-project route defaults.

## Non-Functional Requirements

### Performance

- Workbench panel opens within 2 seconds after activation when dependencies are
  already installed.
- C1 runs outside the extension host event loop.
- Streaming UI should remain responsive during long agent runs.
- Large timelines should virtualize or paginate event rendering.

### Reliability

- KAI should degrade gracefully:
  - Proxy down: Direct-only options still visible where possible.
  - C1 down: agent can run, but memory-dependent features are disabled with a
    clear warning.
  - Missing agent binary: show install/repair guidance.
  - Unknown event: render raw fallback.

### Security and Privacy

- API keys stay in existing secure locations or VS Code secret storage.
- Brain data stays in user-selected local/git-synced folder.
- Config backups must not be uploaded by KAI.
- Logs should avoid dumping secrets or full API headers.
- MCP endpoints should bind locally by default.

### Compatibility

- Windows first, because current workspace is Windows.
- Linux support remains important due Cognitive1 cross-OS workflow.
- VS Code extension first.
- VSCodium fork only after extension limitations are proven.

## Proposed Architecture

### Monorepo Direction

Home repo should be ClaudeCode-Proxy, converted to npm workspaces:

```text
packages/
  proxy/
  cognitive1/
  extension/
```

Both proxy and Cognitive1 remain independently buildable and testable. The
extension package bundles them for the single VSIX.

### Extension Layout

```text
src/
  extension.ts
  proxy/
  cognitive1/
    core/
    mcp-http/
    mcp-stdio-shim/
    git-sync/
  orchestrator/
    orchestrator.ts
    events.ts
    configWriter.ts
    conflictResolver.ts
  adapters/
    claude/
    codex/
    acp/
  panel/
```

### Activation Sequence

1. Read unified KAI settings.
2. Start proxy server.
3. Load Cognitive1 in worker thread or child process.
4. Open configured brain folder.
5. Background git pull if enabled.
6. Start local C1 MCP endpoint.
7. Run configWriter backup/merge.
8. Check agent availability.
9. Update status bar: agent, route, proxy, C1.
10. Register Workbench, Engine Room, Memory, and Sessions views.

## Feature Suggestions To Add

### Must Add Before MVP

- Dependency health screen for Claude, Codex, Qwen, Gemini, proxy, and C1.
- Config backup browser and restore action.
- Adapter conformance snapshot tests.
- Session crash recovery: reopen last task timeline after reload.
- Raw event inspector for adapter debugging.
- Simple keyboard shortcuts for agent switch and route switch.
- Auto Mode toggle with clear permission profile and timeline audit.

### Strong Phase 2 Candidates

- Cost forecast before dispatching large tasks.
- Per-project agent and route defaults.
- Prompt templates for common tasks: review, implement, debug, explain, test.
- Handoff quality checklist before switching agents.
- Memory citation chips inline in assistant responses.
- Workspace risk scanner before allowing large edit tasks.
- Per-agent autonomy defaults, such as Claude Auto for refactors and Codex Review
  for config-sensitive tasks.

### Later Differentiators

- Multi-agent compare mode where two agents analyze read-only and user chooses
  one to implement.
- Task queue with scheduled overnight runs.
- Worktree isolation for risky tasks.
- Team/shared memory mode.
- Inline editor quick actions if VS Code extension APIs are sufficient.
- VSCodium-based distribution for branding and deeper editor integration.

## Phased Delivery Plan

### Phase 0: Foundation

Scope:

- Refactor/contain Cognitive1 sync I/O so it is worker-thread-compatible.
- Set up npm workspaces monorepo in ClaudeCode-Proxy.
- Define extension package boundaries.
- Confirm VSIX packaging path.

Exit criteria:

- Proxy and C1 still build independently.
- Extension package can import/start both in development.
- No UI freeze during basic C1 startup test.

### Phase 1: MVP Spine

Scope:

- Write `VISION.md`.
- Define adapter interface and unified event model.
- Define autonomy modes and permission profile schema.
- Add capability handshake.
- Add fallback raw renderer.
- Register Agent Workbench panel beside existing dashboard.
- Implement Claude adapter first.
- Embed C1 worker and local MCP endpoint.
- Add stdio MCP shim.
- Add configWriter backup/merge.
- Auto-run session_start and recall briefing.
- Show cost tracking in chat header.
- Build read-only Memory sidebar.
- Add orchestrator one-active-agent rule.
- Add Review and Auto autonomy states for Claude.

Exit criteria:

- User can run one Claude task from the Workbench.
- User can run a Claude task in Review mode or Auto Mode.
- C1 briefing appears before/inside the task flow.
- Route badge works for Claude Direct/Proxy.
- Session cost appears.
- Config backups are created before changes.

### Phase 2: Multi-Agent Surface

Scope:

- ACP adapter for Qwen Code and Gemini CLI.
- Codex app-server/headless adapter.
- Codex Auto Mode support.
- Approval cards.
- Diff cards via VS Code WorkspaceEdit with undo.
- Adapter health checks.
- Adapter snapshot tests.

Exit criteria:

- User can choose Claude, Codex, Qwen, or Gemini when installed.
- Claude and Codex can run edit tasks in Auto Mode.
- Unavailable agents show actionable setup messages.
- Diff proposals can be approved or rejected.
- Unknown adapter event shapes appear in raw fallback cards.

### Phase 3: Handoffs and Session History

Scope:

- `/handoff` command.
- brain_handoff to session_start chain.
- Sessions tab.
- Cross-agent session search.
- Writeable memory actions.
- Cost report filters.

Exit criteria:

- User can hand off an active task from one agent to another.
- Incoming agent receives useful context automatically.
- Session timeline records both agents and route/cost state.

### Phase 4: Routing Intelligence and Git Sync

Scope:

- Sticky per-agent route defaults.
- Subscription-exhausted auto-fallback surfaced in header.
- Brain git auto-sync: pull on activate, push after turns.
- Per-project route policy.
- Config drift detection.

Exit criteria:

- KAI remembers preferred route per agent.
- User can see when fallback is active and why.
- Memory sync does not create multiple C1 writers.

### Phase 5: Fork Evaluation

Scope:

- Evaluate whether VS Code extension limitations block important UX:
  - Inline ghost text.
  - Bundled distribution.
  - Branding.
  - Deeper workbench integration.
- If necessary, plan VSCodium fork with minimal core diff.

Exit criteria:

- Written fork/no-fork decision.
- If fork is chosen, at least 95% of KAI code remains extension/package code.

## Testing Strategy

Phase 1 must establish test scaffolding.

Required tests:

- Adapter event model snapshots.
- Capability handshake unit tests.
- Orchestrator handoff chain integration tests.
- Autonomy mode tests proving Review blocks edits until approval and Auto applies
  permitted edits while logging them.
- ConfigWriter backup/merge tests with custom user config preservation.
- C1 worker startup/shutdown tests.
- MCP endpoint smoke tests.
- Proxy route state tests.
- Panel smoke tests for rendering event streams.

Before launch:

- Full round-trip: user prompt -> agent -> C1 recall -> file diff -> approval ->
  file write -> session summary -> memory write.
- Auto Mode round-trip: user prompt -> agent edits files directly -> tests run ->
  timeline logs edits/commands -> user can stop or roll back.
- Windows and Linux activation tests.
- VSIX install/uninstall/reinstall test.
- Config restore test.

## Risks and Mitigations

### Extension Host Memory

Risk:

- Running proxy, C1, and agents from a VS Code extension may pressure memory.

Mitigation:

- C1 in worker thread or child process.
- One-active-agent rule.
- Monitor VS Code process explorer during development.
- Move C1 to child process if worker thread is insufficient.

### Config Corruption

Risk:

- Writing Codex/Qwen/Gemini settings could damage user custom configs.

Mitigation:

- Backup before write.
- Merge targeted blocks only.
- Show diffs.
- Add restore button.
- Build tests around real-world config samples.

### Over-Autonomous Edits

Risk:

- Auto Mode could let an agent make broad or unwanted changes too quickly.

Mitigation:

- Make autonomy mode highly visible.
- Scope Auto Mode to task/workspace/agent.
- Keep destructive operations separately gated.
- Create checkpoints before large edit batches.
- Provide stop and rollback controls in the timeline.
- Default new workspaces to Review mode unless the user changes the preference.

### Adapter Divergence

Risk:

- Agents stream different event shapes and change over time.

Mitigation:

- Capability handshake.
- Raw fallback renderer.
- Snapshot tests.
- Raw event inspector in developer mode.

### C1 File Races

Risk:

- Multiple C1 instances can write to the same brain files.

Mitigation:

- One embedded C1 instance owned by KAI.
- Agents connect to the KAI-owned MCP endpoint or stdio relay.
- Brain data externalized and locked/coordinated.

### Vendor/API Churn

Risk:

- Claude SDK, Codex app-server, ACP, or provider model names may change.

Mitigation:

- Keep vendor-specific code behind adapters.
- Centralize model presets.
- Add health checks and version reporting.
- Prefer graceful warnings over hard failure.

## Open Questions

- Should KAI live in the existing ClaudeCode-Proxy repo as planned, or should
  this empty `KAi` folder become a planning/docs repo only?
- Which agents are required for MVP: Claude only, Claude+Codex, or all four?
- Should configWriter apply changes automatically on activation, or ask first
  during early builds?
- Should Auto Mode default to off globally, or remember the user's last setting
  per workspace?
- Which operations should remain approval-gated even in Auto Mode?
- Should C1 run as worker thread or child process for the first prototype?
- What is the default brain data folder path on Windows and Linux?
- Should the first UI be polished webview HTML/CSS or a simpler diagnostic-first
  panel until adapters stabilize?
- How much cost tracking can be exact versus estimated for each native agent?

## MVP Definition

The smallest compelling MVP is:

- One VSIX.
- Workbench panel.
- Claude adapter.
- Embedded C1 worker with local MCP.
- Proxy route toggle.
- Review/Auto autonomy toggle.
- ConfigWriter backup/merge for the minimum required configs.
- Unified event model with raw fallback.
- Cost visible in header.
- Read-only Memory view.
- One-active-agent orchestrator.
- Basic tests proving event mapping, config safety, and C1 startup.

The marquee early expansion after MVP should be Codex support, because it makes
the "multiple real agents in one workbench" value obvious quickly.

## Launch Checklist

- Build VSIX.
- Install fresh on Windows.
- Open clean workspace.
- Confirm proxy starts.
- Confirm C1 starts with selected brain folder.
- Confirm config backups are created.
- Confirm Claude Direct task works.
- Confirm Claude Proxy task works.
- Confirm session appears in Memory/Sessions.
- Confirm uninstall does not delete brain data.
- Confirm standalone agent CLIs still work after KAI config injection.
