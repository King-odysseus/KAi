# KAI Desktop Roadmap

Created: 4 October 2026.
Source: [Desktop product audit](KAI_DESKTOP_PRODUCT_AUDIT_2026-10-04.md).
Status: proposed implementation backlog; no application changes are claimed by this document.

## Objective

Make KAI a dependable, integrated agent workbench where a request can be followed through planning, execution, verification, review, and reusable C1 knowledge. Prioritize composer, Project Studio, and C1 while retaining agent neutrality and portable project data.

## Audit follow-through (2 November 2026)

The product audit's cross-window and task-evidence gaps are addressed in the current source:

- New-conversation drafts and restored conversation tabs are scoped to the active project. Conversation tabs from another project are hidden, and opening a conversation aligns the window to its project first.
- The main process checks that a window creates, saves, verifies, and runs conversations only for its own project. Ordinary interactive runs in the same project are serialized; Compare, Evals, and Autopilot retain their isolated worktree flows.
- The composer shows the project name and folder path before a run. Goal-based verification records and run-learning notes retain the goal ID and outcome so checks and memory drafts can be traced back to the task.
- Queue and steer controls, side questions, recovery/resume, workflow templates, skills, prompt presets, and saved cross-agent eval comparisons already exist. Roadmap work should connect and simplify these flows rather than add parallel versions.

The desktop typecheck passed after these changes. Tests were not run for this implementation update.

## Delivery approach

- Deliver small, usable increments. Every phase ends with a working user flow and a documented validation result.
- Extend current queues, specifications, workflows, verification, and memory review rather than introducing competing systems.
- Recheck findings against current source before implementing them. The audit's initial Studio errors were resolved by concurrent work and are not automatically open tickets.
- Preserve existing uncommitted work. Record a stable baseline revision before broad validation.
- Use isolated projects, application profiles, provider fixtures, and temporary Git remotes. Keep real credentials and CLI configuration untouched during automated verification.
- Keep `.kai/spec` readable and versioned. Add versioned contracts and backward-compatible migrations for persisted changes.
- Refactor controllers only as needed to deliver a feature or eliminate an observed state problem.
- Dependencies below describe implementation order, not a requirement for parallel agents.

## Phase map

| Phase | Outcome | Dependency | Relative effort |
|---|---|---|---|
| 0. Baseline | Reproducible source and packaged-app assessment | None | Small |
| 1. Reliability | Safe board storage, honest checks, predictable rules | 0 | Medium |
| 2. Shared task model | Linked tasks, criteria, runs, evidence, and review | 1 | Large |
| 3. Composer | Durable requests and controllable context | 2 | Large |
| 4. Studio | Traceable planning and safe project evolution | 2; integrate with 3 | Large |
| 5. C1 | Traceable lessons, useful recall, reliable delivery | 2; inspect external engine in 0 | Large |
| 6. Integrated workbench | One coherent project and execution experience | 3, 4, 5 | Medium |
| 7. Power features and release | Recipes, branches, team planning, delivery readiness | 6 | Large |

Effort is comparative, not a calendar estimate. Estimate tickets after baseline and C1 engine inspection; release each completed milestone independently.

## Phase 0: establish the baseline

### Work

1. Inventory current worktree changes and confirm applicable project instructions.
2. Re-run desktop type-checking, the full test suite, and desktop build against a stable revision.
3. Run isolated desktop smoke suites and inspect composer, Studio, and Brain visually in the built application.
4. Exercise new-project creation, existing-project opening, queued send, interrupted run, C1 outage, change review, and restore.
5. Locate the actual C1 engine and document supported IDs, revisions, retrieval modes, feedback, draft, mirror, and migration capabilities. Separate desktop changes from engine changes.
6. Reproduce board concurrency risks with two controlled callers before choosing a locking strategy.
7. Investigate the Windows terminal helper `AttachConsole failed` output separately from passing terminal assertions.

### Deliverable and exit criteria

- A baseline record names the revision/build, commands, results, screenshots, and known limitations.
- Audit issues are labeled confirmed, resolved, unverified, or outside the desktop repository.
- Installed-app and source behavior are compared; no stale build is treated as current source.
- Existing flows have a documented behavioral baseline before schema or UI changes begin.

## Phase 1: strengthen reliability

### R1. Protect board data

- Return distinct missing, valid, and invalid board-read states.
- Preserve corrupt files and expose validation errors with a recovery action.
- Restore from spec history or explicitly replace after user selection; block routine mutations of invalid data.
- Serialize board mutations per project in the owning process and add revision checks. If multiple processes can write, define an explicit cross-process ownership/locking protocol.
- Detect external hand edits and reject stale writes with an actionable reload/merge result.

Acceptance: malformed JSON cannot be silently replaced; two simultaneous claims produce one owner; concurrent unrelated updates are retained; stale revision writes do not overwrite newer data; restore preserves the original corrupt bytes.

### R2. Make verification outcomes honest

- Introduce pass, fail, unknown, and not-applicable outcomes for UI checks.
- Treat missing required tokens as unknown/blocked; not-applicable requires a stated reason.
- Rename weak existing checks to describe what they actually measure until real interactions replace them.
- Keep screenshot capture distinct from approved-baseline comparison.

Acceptance: absent tokens, declared states, and a single focusable element cannot produce an unsupported claim of full visual/accessibility correctness.

### R3. Correct instruction precedence

- Inventory standing-rule injection and generated instruction copies across adapters.
- Define precedence that respects host policies and current user instructions; historical memories remain reference data.
- Show rule origin and precedence in context inspection. Surface explicit conflicts without pretending to detect every semantic conflict.
- Update generated copies and stale-copy handling consistently.

Acceptance: an authorized current request can override user-owned standing preferences on both CLI and direct-provider paths; retrieved memory cannot become a higher-priority instruction.

### R4. Account for mirror rejection

- Inspect HTTP responses for optional mirror writes and report failures.
- Preserve primary-write success independently of mirror status.
- Add delivery identifiers compatible with the durable outbox planned in Phase 5.

Acceptance: HTTP 401, 429, and 500 are visible delivery failures; none falsely marks delivery successful or fails the primary learn operation.

Primary files: `main/board.ts`, `main/spec-store.ts`, `main/ui-check.ts`, `main/context-builder.ts`, `main/execution-rules.ts`, `main/cognitive1-client.ts`, relevant contracts and tests. Paths are relative to `apps/desktop/src` unless stated otherwise.

## Phase 2: create a shared task and evidence model

### Proposed contracts

| Record | Required relationships and fields |
|---|---|
| Task | Stable ID, project ID, optional conversation/card references, request, goal, status, revision, execution choices, context snapshot reference |
| Criterion | Stable ID, task/story reference, checkable statement, required evidence types, required/optional flag, revision |
| Run | Existing run ID linked to task, selected adapter/provider, state, timestamps, usage, changed files/checkpoint |
| Evidence | ID, criterion/run references, kind, outcome, command or artifact, relevant file hashes/commit, criterion revision, timestamp |
| Review | Task/run reference, decision, evidence reviewed, unresolved items, explicit waivers and reasons |
| Lesson draft | Task/run references, source evidence, project scope, structured reusable finding, review state |

### Work

1. Add versioned Zod contracts and a durable main-process task store using existing atomic storage patterns.
2. Link existing conversation, card, workflow, and run IDs through the task record. Preserve their distinct meanings and existing histories.
3. Define legal task transitions: draft, queued, running, blocked, review, completed, failed, cancelled. Pause/resume must preserve the resumable state.
4. Migrate acceptance strings into stable criteria. Older completion history remains visible but is identified as legacy evidence.
5. Require current evidence for each required criterion, or an explicit human waiver with a reason. Changes to criteria or relevant files invalidate affected evidence.
6. Implement one end-to-end slice: composer request -> Studio card -> run -> recorded check -> review -> lesson draft.

Acceptance: every record in the slice is navigable; stale evidence cannot close a required criterion; task IDs survive restart; one task can have multiple runs without duplicating the task; legacy data is backed up and migrated without inventing evidence.

Primary areas: `packages/contracts/src`, `packages/runtime/src/atomic-json-store.ts`, desktop `main/ipc.ts`, `main/verification.ts`, `main/board.ts`, `main/run-history.ts`, `main/run-learning.ts` and preload APIs.

Milestone A: a reliable task can be followed from request to reviewed result, even with a basic UI.

## Phase 3: make the composer a strong task workspace

### C1. Durable drafts and queues

- Move persisted drafts/queues behind the main-process store and migrate localStorage once with validation and backup.
- Preserve execution choices, context, attachment references, and task identity when editing or reordering queued items.
- Use client message IDs and accepted-turn reconciliation for dispatch recovery. Do not promise exactly-once external execution where an adapter cannot confirm acceptance.
- Make uncertain delivery visible; retries must not silently duplicate known accepted turns.
- Distinguish live steering from a follow-up queued turn according to adapter capability.

Acceptance: restart before send, during dispatch, and after accepted-turn persistence retains the correct queue; editing preserves options; missing attachments block with a repair action; persistence errors are visible.

### C2. Inspect and control context

- Provide an expandable pre-send summary: project, provider/model, autonomy, goal, attachments, planned checks, context estimate, and applicable budget.
- Add pin/exclude controls, truncation indicators, and estimated token use by section.
- Record a context snapshot so the sent task can be inspected later.
- Distinguish approximate pricing/token estimates from measured usage and unknown prices.

Acceptance: excluded context is absent from the sent request; pinned items have explicit overflow behavior; changed files/context are reflected before send; estimates never appear as guaranteed charges.

### C3. Refine without changing intent silently

- Show original/refined comparison and added assumptions.
- Accept or reject meaningful changes, retain undo, and bind refinement results to the originating draft revision.
- Ignore or present stale responses separately when the draft/project changes.

Acceptance: delayed refinement cannot overwrite a newer draft; rejecting refinement keeps the original; suggested assumptions are visible.

### C4. Simplify execution controls

- Show adapter capabilities for images, tools, steering, resume, and structured outputs.
- Keep common send controls compact and advanced settings expandable.
- Connect run progress to plan, tools, approvals, checks, changed files, and next action.

Primary areas: renderer `components/Workspace.tsx`, `components/composer-queue.ts`, `components/composer-settings.ts`, `App.tsx`; main context, run-control, recovery, and IPC services.

## Phase 4: turn Studio into a project lifecycle tool

### S1. Import existing projects

- Inventory repository structure, existing specifications, stack, scripts, and tests.
- Produce an editable baseline with sources and explicit unknowns; do not overwrite existing specs on import.
- Link imported requirements to the shared task model.

Acceptance: an existing project can enter Studio without recreating it; assumptions and absent information are clearly identified; import preview precedes writes.

### S2. Safe regeneration and impact review

- Keep stable requirement/story/card IDs across artifact regeneration.
- Preview added, changed, removed, and unaffected artifacts/cards.
- Archive removed cards with their runs and evidence. Preserve user edits or expose conflicts.
- Mark affected downstream artifacts, criteria, and evidence stale using recorded dependency/revision relationships.

Acceptance: regenerating a plan preserves completed-card history; rejected previews write nothing; requirement edits invalidate only the relevant evidence; interrupted application does not leave a partially applied plan.

### S3. Milestones and dependency planning

- Add MVP/milestone scope, estimates, blocked reasons, and a local runnable milestone.
- Validate missing dependencies and cycles before execution.
- Show the critical path when estimates exist; disclose uncertainty rather than imply precise schedules.

Acceptance: cyclic or missing dependencies cannot appear ready; milestone status derives from its required cards/criteria; a user can explain why a card is blocked.

### S4. Executable acceptance and design review

- Link criteria to supported check commands and interaction scenarios.
- Exercise actual empty/loading/error/disabled states using controlled fixtures.
- Add keyboard navigation/activation, focus visibility and modal behavior checks where applicable.
- Support approved screenshot baselines by route, viewport, and theme; baseline updates require deliberate review.
- Present visual evidence alongside changed code and design tokens.

Acceptance: a build does not satisfy a behavioral criterion; simulated failures prove error-state behavior; a layout regression is detected against a baseline; applicable keyboard scenarios must pass before completion.

Primary areas: `main/studio.ts`, `main/artifacts.ts`, `main/board.ts`, `main/interview.ts`, `main/design-source.ts`, `main/ui-check.ts`, renderer `StudioView.tsx`, and `packages/contracts/src/studio.ts`.

Milestone B: both new and existing projects can evolve through reviewed plans and evidence-backed delivery.

## Phase 5: make C1 an evidence-backed learning system

### B1. Identity and provenance

- Coordinate desktop and engine contracts for immutable memory IDs, revisions, stable project identity, source task/run/evidence, scope, and last validation.
- Update editing, feedback, imports, and deduplication to use IDs.
- Support older engines through explicit capability negotiation. If only title-based updates exist, detect ambiguity and request disambiguation; never fabricate authoritative engine IDs.

Acceptance: same-title entries in different projects remain distinct; migration retains originals; source links open the relevant run/evidence; unsupported engine capabilities are clearly indicated.

### B2. Structured lesson review

- Extend drafts with symptom, cause, resolution/decision, evidence, scope, and applicability.
- Admit useful diagnosis and decisions without file edits when supported by evidence.
- Label hypotheses and unverified claims separately; do not promote them as verified fixes.
- Allow edit, merge, reject, and approve; preserve duplicate/supersession relationships.

Acceptance: a no-edit diagnosis can become a reviewed draft; a failed run's unsupported conclusion cannot become a verified lesson; a draft can be traced to its origin.

### B3. Freshness and contradictions

- Model active, resolved, superseded, disputed, and needs-validation states.
- Link conflicts and replacements with reasons and dates.
- Retain historical knowledge while excluding obsolete guidance from default grounding where appropriate.

Acceptance: superseded entries remain discoverable but are identified as historical; conflicting active lessons expose the disagreement and applicable scope.

### B4. Explain and evaluate recall

- Show project/global origin, match reason, freshness, and provenance of used memories.
- Build a labeled query set covering exact errors, conceptual queries, cross-project lessons, duplicates, and outdated advice.
- Compare lexical, semantic, and hybrid retrieval before selecting automatic grounding defaults.
- Keep lexical fallback and the existing bounded startup memory budget.

Acceptance: automatic recall mode is explicit; project boundaries survive deduplication; the chosen retrieval strategy improves measured relevance without unacceptable startup latency; C1 outage does not prevent a normal run and missing grounding is stated.

### B5. Reliable optional mirroring

- Persist an outbox with delivery ID, primary memory ID, attempts, status, and retry time.
- Use receiver-supported idempotency, bounded retries/backoff, and authentication-failure handling.
- Expose pending/failed delivery and explicit retry. Reconcile crash-after-post cases without creating duplicate knowledge.

Acceptance: restart preserves pending writes; 401 is actionable, 429 respects retry information, and 500 retries within bounds; duplicate posts do not duplicate receiver knowledge where negotiated support exists; primary success remains independent.

Primary areas: `packages/contracts/src/brain.ts`, desktop `main/cognitive1-client.ts`, `main/brain-project.ts`, `main/brain-mirror.ts`, `main/run-learning.ts`, `main/ipc.ts`, renderer `BrainView.tsx`/`Cognitive1Panel.tsx`, plus the separately inspected C1 engine.

Milestone C: reviewed results yield traceable lessons that improve subsequent runs.

## Phase 6: integrate the workbench experience

1. Add a project overview with current goal, active tasks, blockers, preview, recent changes, evidence, memory health, and next useful action.
2. Connect task detail navigation across composer, Studio, workflows, review, and Brain.
3. Standardize cancellation, pause, restart recovery, and resumability across long operations. Show whether cancellation was requested or acknowledged.
4. Consolidate change review: diff, criterion status, checkpoint restore, worktree merge, and final review decision.
5. Surface service states with specific recovery actions: unavailable, signed out, rate limited, misconfigured, or incompatible.
6. Carry budgets across workflow members, retries, and fallback routes; state the boundary of what KAI can actually enforce.
7. Verify keyboard navigation, focus restoration, screen-reader names, large text, and reduced motion across the integrated flows.

Acceptance: users can resume and explain a project's state from its overview; switching projects/windows does not leak stale results; failures point to a useful recovery action; review shows unresolved requirements before acceptance.

## Phase 7: add power features and release confidently

### Extensions

- **Task recipes:** save successful intent/context/check preferences; version them and exclude secrets.
- **Conversation branches:** fork a turn with explicit context and optional isolated worktree; compare and review before merge.
- **Team planning:** select agents by actual capabilities and context needs, detect overlapping writes, track integration checks, and support cancellation/recovery.
- **Delivery readiness:** summarize behavior checks, build, remaining risks, configuration requirements, migration notes, rollback instructions, and exportable artifacts.

### Release validation

- Validate migrations and rollback against representative older app data; preserve user backups.
- Run full tests, desktop type-checking/build, and existing smoke suites on a stable revision.
- Run packaged Windows end-to-end scenarios with isolated profiles: new project, existing project, interrupted queue, provider failure, C1 outage, regeneration, review/restore, and worktree integration.
- Recheck Electron/security maintenance, navigation/IPC boundaries, updater behavior, Windows paths, permissions, and terminal behavior.
- Measure startup, composer send latency, Studio generation overhead, recall latency, and responsiveness on representative large histories/projects. Set budgets from the Phase 0 baseline before judging regression.

Acceptance: no unresolved data-loss, duplicate-dispatch, or unsupported-completion defects in the required scenarios; release notes distinguish validated behavior from remaining limitations.

## Suggested ticket and change boundaries

| Order | Ticket | Completion evidence |
|---|---|---|
| 1 | Stable baseline and live desktop inspection | Revision, test/build results, smoke screenshots, issue dispositions |
| 2 | Invalid-board recovery | Corrupt data retained; recovery works; normal writes blocked |
| 3 | Board mutation revisions | Concurrent callers and external edits tested |
| 4 | Honest UI outcome semantics | Missing evidence stays unknown; weaker checks labeled accurately |
| 5 | Instruction hierarchy | User overrides tested across execution paths |
| 6 | Mirror response handling | Rejection status surfaced without breaking primary writes |
| 7 | Task/criterion/evidence contracts and migrations | Round-trip legacy data and one linked task flow |
| 8 | Criterion-level completion gate | Current evidence/waivers required for every required criterion |
| 9 | Durable composer queue and recovery | Restart and uncertain-delivery scenarios |
| 10 | Composer context controls and refinement comparison | Sent context matches selections; stale refinement protected |
| 11 | Studio import and regeneration preview | Existing spec preserved; plan changes reviewed atomically |
| 12 | Studio milestones and interaction evidence | Valid dependencies and actual behavioral/UI checks |
| 13 | C1 IDs/provenance and structured lessons | Distinct identities and evidence-linked drafts |
| 14 | C1 supersession and recall evaluation | Historical guidance labeled; strategy chosen from measured results |
| 15 | Durable mirror outbox | Restart/retry/idempotency scenarios |
| 16 | Integrated project overview and review | Complete request-to-memory walkthrough |
| 17 | Recipes, branches, team and delivery readiness | Isolated execution and reviewed integration |
| 18 | Packaged release qualification | Stable-revision checklist and documented limitations |

Each ticket should name the user-facing result, migration requirements, relevant files, failure cases, and acceptance evidence. Split large tickets into vertical increments; do not merge unrelated schema, UI, and release changes into one review.

## Completion definition

The roadmap is achieved when KAI supports a demonstrable request-to-memory loop for both new and existing projects: context is inspectable, planning is revisable, execution is recoverable, required outcomes have current evidence, changes are reviewable, and retained lessons are traceable and useful. Every phase must preserve the user's control and work across supported agents through neutral contracts.
