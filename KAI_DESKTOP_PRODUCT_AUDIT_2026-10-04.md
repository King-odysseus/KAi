# KAI desktop product and engineering audit

Date: 4 October 2026. Scope: the standalone Electron desktop app, shared contracts/runtime/integrations, and relevant tests. Extra attention: composer, Project Studio, and Cognitive1 (C1).

## Overall assessment

KAI already has the ingredients of a powerful agent workbench. Its main opportunity is to connect them into a dependable loop: understand the request, plan the project, execute work, prove the result, review changes, and retain useful knowledge. Adding more independent panels before strengthening that loop will increase complexity faster than usefulness.

This is a source and automated-test audit, not a certification of the installed executable. No live provider calls, visual inspection of the running app, packaged-app smoke tests, or penetration tests were performed. The external C1 engine's retrieval internals were not audited. Existing uncommitted changes were present, including Studio changes; findings describe the current working tree and are not attributed to a released version. Application code was not changed.

## What is already valuable

- Composer: task intents, agent/model/route/autonomy controls, context attachments, prompt refinement, goals, queueing, live steering where supported, and context previews.
- Studio: project interviews, generated specifications, versioned files under `.kai/spec`, artifact dependencies and staleness, design import, board planning, team handoff, and review gates.
- C1: scoped recall, lexical and semantic search choices, useful/unhelpful feedback, draft review operations, quality metrics, project-name resolution, Git sync, and optional mirroring.
- Execution: provider adapters, workflows, team coordination, worktrees, checkpoints, recovery, budgets, diagnostics, run history, and verification.
- Desktop boundaries: renderer sandboxing, context isolation, disabled Node integration, navigation restrictions, and IPC sender/input validation are present.

These should be extended rather than rebuilt as duplicate features.

## Confirmed findings and concrete risks

### 1. Studio type-check errors observed in the initial snapshot

`apps/desktop/src/main/studio.ts:238` references `ReplyShapeError` without a definition/import that TypeScript can resolve. At line 426, the result includes `tokensPreserved`, but its declared return type does not include it. `npm run desktop:typecheck` exits unsuccessfully before renderer checking completes.

The working tree changed during the audit: a subsequent read shows the import and `tokensPreserved` return annotation have been added by other ongoing work. These are initial-snapshot findings, not claims that those errors still exist. A second type-check reached the renderer and failed at `StudioView.tsx:132` with an unresolved `projectTitleFrom` reference. Require node and renderer type-checking in the release gate. Revalidate a stable revision after the ongoing edits finish.

Final targeted recheck: desktop type-checking passed after further concurrent edits. These errors are now historical observations from the audit, not open defects in the final observed source.

### 2. Studio fallback behavior and its test disagree

The Studio flow test for building a board when the model does not return card JSON fails with `no canned reply for kai_studio_board`. The implementation now falls back only for `ReplyShapeError`, while the fixture supplies a generic error. Distinguish malformed replies from authentication, transport, and provider errors. Test each behavior explicitly; do not restore indiscriminate fallback just to make the old test pass.

Final targeted recheck: the fixture was updated by concurrent work and all 25 Studio flow tests passed. The initial failing result below is retained to describe the earlier snapshot.

### 3. Standing rules claim priority over the user's request

`context-builder.ts` renders standing rules that explicitly override conflicting project or user instructions. The generated `.kai/instructions.md` repeats this claim. That undermines deliberate user overrides and can make the same app behave differently across harnesses.

Define an explicit instruction hierarchy consistent with actual host/provider policies. User-owned standing preferences should not silently defeat a current authorized request. Show instruction origins and conflicts in the context preview. Test overrides across CLI and direct-provider paths.

### 4. Board completion proves a check passed, not every requested outcome

`board.ts:doneBlockedBy` checks verification history, passing status, visual status where required, and current file hashes. Those are useful protections. However, that function does not require criterion-by-criterion evidence for the card's `acceptance` strings. A passing command can still provide weak evidence for the requested behavior.

Give criteria stable IDs and attach evidence to each one. Distinguish static analysis, unit, integration, end-to-end, visual, accessibility, and explicit human review evidence. A criterion should be passed, failed, blocked, or explicitly waived with a reason. Keep the existing hash-based freshness protections.

### 5. The visual check currently overstates what it proves

`ui-check.ts:evaluateUiChecks` passes keyboard reachability when `tabbables > 0`. The DOM probe counts selectors, including potentially hidden or disabled elements, rather than actually navigating. States are inferred from attributes or declarations. Screenshots are captured, but the inspected pass decision uses DOM facts rather than image comparison. Missing design tokens produce an empty comparison and a passing token result.

Use pass/fail/not-applicable/unknown outcomes. Exercise focus order, visible focus, keyboard activation, modal focus trapping, and actual error/loading/empty states. Compare approved image baselines where appropriate. Missing required tokens should be unknown or blocked. Saved screenshots remain useful evidence, but should not alone imply visual correctness.

### 6. An invalid board is presented as empty

`StudioBoardStore.read` returns a new empty board when existing JSON is invalid or fails schema validation. This masks corruption as a normal new-project state and creates a risk that a later write replaces the user's board.

Differentiate missing, invalid, and valid board data. Preserve invalid bytes, show the file path and error, and offer recovery from spec history. Block ordinary writes until recovery or explicit replacement.

### 7. Board read-modify-write operations need concurrency verification

Claims and updates read the board, change it, then save it. The store shown does not itself serialize those transactions. Two concurrent callers could both observe an unclaimed card or overwrite unrelated changes unless a higher layer guarantees serialization. This is a code-level risk, not a reproduced race in this audit.

Use per-project serialized mutations and revision checks. Verify concurrent claim, run recording, user drag, and team updates across windows and MCP clients. Atomic file replacement alone does not prevent lost updates.

### 8. Memory identity and evidence are weak in the desktop contract

`brainEntrySchema` carries date, title, agent, type, tags, project, generic fields, and status, but no first-class immutable ID, revision, source run, commit, retrieval score, or validity interval. Field updates address an entry by title. `context-builder.ts` deduplicates by date/type/title, omitting project.

Add stable entry/project IDs and explicit provenance. Keep migration compatibility for older entries. Update and vote by ID. Make deduplication project-aware. Show the evidence and current applicability of a recalled lesson.

The automatic pre-run recall path in `ipc.ts:recallScopedMemories` queries project memories and tops up from global results. It does not pass a search mode, so the desktop search contract's lexical default applies. Semantic search being available in the Brain UI does not mean automated run grounding uses it. Evaluate hybrid recall for automatic grounding, preserve project/global labels, and use IDs rather than type/title to deduplicate across projects.

### 9. Automatic learning misses some valuable work

`run-learning.ts:composeRunLesson` ignores runs with no changed files and requires a sufficiently long closing message. This filters noise, but also excludes useful diagnosis, research decisions, and failures before any edit. It creates short summaries rather than structured causal knowledge.

Extend the draft pipeline with supported lesson types: symptom, cause, fix, evidence, scope, and conditions where it applies. Allow evidence-backed lessons without edits. Keep review and deduplication before durable promotion.

### 10. Live mirror writes need delivery accounting

`cognitive1-client.ts:mirrorLearn` fires optional mirror writes after a successful primary operation. It awaits `fetch` but does not inspect the response status. HTTP rejection can therefore look like successful delivery to that path. Network exceptions reach the error callback, but there is no durable delivery record in this method.

Check response status and add a persistent outbox with idempotency keys, bounded retries, and visible pending/failed delivery state. Continue allowing primary learning to succeed independently.

### 11. Composer persistence is useful but should become a stronger contract

`composer-queue.ts` saves queues in localStorage, removes image data URLs, and detects already accepted turns using client message IDs. Good foundations. Queue loading checks only a subset of fields and casts the options; send state resets on reload. Persistence failure is returned as a boolean.

Move durable drafts and queued tasks behind the main-process store, validate versioned schemas, and preserve all execution/context choices when editing a queued item. Inspect the existing caller's handling of failed persistence before changing it. Test restart during dispatch and attachment relocation.

### 12. Large UI controllers make cross-feature changes harder

The inspected App, Workspace, and StudioView files contain roughly 2,334, 2,455, and 2,061 lines respectively. File length alone is not a defect, but these components coordinate many independent asynchronous states.

Extract durable task state and focused feature controllers incrementally. Bind requests to project, conversation, and revision. Prioritize extraction where it removes an observed race or makes recovery testable.

## Composer improvements

| Improvement | User benefit | Minimum useful version |
|---|---|---|
| Pre-send task summary | Knows what will run and with which context | Expandable summary of intent, target project, agent/model/provider, permissions, goal, attachments, expected checks, and approximate budget |
| Editable context budget | Better answers without unnecessary token use | Per-section estimates, pin/exclude controls, truncation warnings, and file/selection relevance hints |
| Reusable task recipes | Repeat successful workflows | Named recipes storing intent, context sources, permissions, and verification preferences; no secrets |
| Durable task queue | Trusts queued work across restarts | Schema-validated storage, reorder, edit preserving options, dependency/blocking controls, visible recovery |
| Prompt refinement diff | Retains control of meaning | Compare original/refined text, expose added assumptions, accept individual changes |
| Capability-aware controls | Predictable behavior across agents | Clear live-steering, image, tool, resume, and structured-output capabilities for the selected route |
| Execution timeline | Understands progress and intervention points | Plan, tools, approvals, checks, changes, cost, and next action in one coherent run view |
| Deliberate conversation branching | Explores alternatives safely | Fork from a turn with explicit context and optional isolated worktree; compare results before merging |

Do not introduce another mode for every new capability. Keep common actions visible and place advanced configuration behind an expandable area.

## Project Studio improvements

| Improvement | User benefit | Minimum useful version |
|---|---|---|
| Import an existing project | Studio remains useful after project creation | Repository inventory, existing architecture/spec import, explicit unknowns, and an editable baseline |
| Requirement-to-evidence links | Can see which features actually work | Requirement/story IDs linked to cards, files, runs, criteria, tests, and review evidence |
| Change impact preview | Revises a project without losing good work | Diff of changed requirements and affected artifacts/cards before regeneration |
| Regeneration review | Prevents accidental plan replacement | Added/changed/removed card preview; archive removed cards and preserve history |
| Milestones and critical path | Plans useful increments | MVP scope, dependencies, cycle detection, blocked reasons, estimated effort, and a local runnable milestone |
| Capability-aware team planning | Assigns work sensibly | Match tools/context needs to available agents; isolate overlapping edits and show merge status |
| Executable acceptance plans | Gets behavior that matches the spec | Per-criterion checks with evidence type and human waiver support |
| Design review workbench | Connects intended design to implementation | Route-linked screenshots, tokens, responsive states, baseline approval, and accessibility results |
| Delivery readiness | Understands whether the project is ready to ship | Build, behavioral checks, remaining risks, required configuration, migration/rollback notes, and artifact export |

Preserve `.kai/spec` as portable, readable project data. Add structure alongside readable documents rather than locking specifications inside application state.

## C1 brain improvements

| Improvement | User benefit | Minimum useful version |
|---|---|---|
| Evidence-backed memory | Can trust a lesson | Stable IDs, source run/commit/file, verification evidence, scope, and last validated date |
| Explained retrieval | Understands why memory was used | Match reason, project/global origin, relevance, freshness, and direct evidence links |
| Hybrid retrieval experiment | Finds both exact errors and related concepts | Combine existing lexical/semantic paths, measure relevance on saved queries, and retain lexical fallback |
| Contradiction and supersession | Avoids repeating obsolete advice | Link conflicting entries; mark superseded/resolved lessons and explain which applies |
| Structured lesson review | Creates reusable knowledge | Editable symptom/cause/fix/evidence drafts; merge duplicates before approval |
| Project memory overview | Resumes with less repetition | Current decisions, unresolved bugs, risks, handoffs, and recent validated changes |
| Memory quality evaluation | Measures usefulness rather than entry volume | Relevant recall rate, stale/contradictory recall, validated lessons, repeat failures, and feedback effectiveness |
| Reliable synchronization | Knows whether brains agree | Outbox state, retry history, conflict preview, idempotent import, and export/restore verification |

The app already exposes semantic recall, feedback, review, and quality operations. These recommendations strengthen them; they do not assume the underlying C1 engine lacks those features. Inspect that engine before selecting storage or embedding changes.

## Improvements across the rest of the app

- A project home showing current goal, runnable preview, active tasks, blockers, recent changes, checks, memory health, and the next useful action.
- One task identity shared by composer, Studio card, workflow, agent run, checkpoint, verification, and lesson draft. Keep project and conversation identities distinct.
- A service health panel that distinguishes unavailable, signed out, rate limited, misconfigured, and incompatible services, with tested recovery actions.
- Consistent cancellation and resumability for interviews, artifact generation, design builds, workflows, and long runs. Record acknowledged cancellation separately from completion.
- A change-review flow connecting diffs, acceptance evidence, checkpoint restore, worktree merge, and the final result.
- Budget controls across a complete workflow, including retries, team members, and fallback routes; explain estimates versus measured usage.
- Keyboard navigation, screen-reader labels, focus restoration, large text, and reduced motion verified across primary flows.
- Release discipline: current Electron maintenance, isolated packaged-app smoke tests, migrations, backup/restore, updater rollback, and Windows path/permission cases.

Electron recommends current framework versions, restricted navigation, sender validation, isolation, and sandboxing. Existing code includes several of these protections; dependency maintenance and security regression tests should remain release work: https://www.electronjs.org/docs/latest/tutorial/security.

## Recommended implementation order

1. **Reliability baseline:** verify the ongoing Studio type-error fixes, resolve the fixture mismatch, reject corrupt-board writes, verify mutation serialization, correct instruction hierarchy, and make missing UI evidence explicit.
2. **One dependable task loop:** introduce shared task/criterion/evidence identities; connect composer, Studio, execution, review, and C1 draft provenance. Improve durable queueing and recovery here.
3. **Project evolution:** existing-project import, regeneration diff, milestone/dependency controls, and requirement change impact.
4. **Memory quality:** stable IDs, structured lessons, applicability/supersession, explained retrieval, delivery outbox, and retrieval evaluations.
5. **Power features:** task recipes, isolated branches, team capability matching, richer design comparison, and delivery automation.

Do not begin by adding more providers, dashboards, or autonomous modes. First make a completed task a result whose requested behavior, evidence, changes, and reusable lesson can all be inspected.

## Example of the intended integrated experience

A user asks, "Add account recovery to this project."

1. The composer identifies the active project, attaches relevant authentication files and scoped lessons, and shows the selected provider, permissions, and estimated context use.
2. Studio creates a small set of linked requirements and cards, including invalid addresses, expired links, rate limiting, and accessible recovery screens. Unresolved product decisions remain explicit.
3. The agent works in the appropriate workspace and reports changed files against the task. Independent cards can be assigned to a team with overlap checks.
4. Verification attaches evidence to each criterion. A passing build cannot substitute for an expired-link behavior check. Screenshots and keyboard interaction checks cover the UI criteria.
5. Review presents the diff, unresolved criteria, and restore/merge options. The user can accept a complete result or see exactly what is still blocked.
6. C1 receives a draft lesson tied to that run and its evidence. It records a reusable finding, such as a token-expiry gotcha, instead of treating every code change as lasting knowledge.

This is the most valuable organizing principle for the next version: each existing part makes the next part more effective.

## Success criteria

- A request can be followed from composer through the Studio card to its changed files, checks, review, and memory draft.
- Every required criterion has current evidence or a visible unresolved/waived state.
- Restarting during generation or dispatch preserves work and does not duplicate accepted requests.
- Two windows or agents cannot silently claim the same card or overwrite each other's updates.
- A specification change shows impact before replacing artifacts or tasks.
- Recalled memories have traceable origin, scope, and freshness, and rejected mirror writes are visible.
- The installed package passes isolated end-to-end flows for a new project, existing project, provider failure, restart, review/restore, and C1 outage.

## Validation

- `npm run desktop:typecheck`: failed with the two Studio errors described above.
- A second type-check after concurrent edits reached renderer checking and failed on `StudioView.tsx:132`, unresolved `projectTitleFrom`. The two initial main-process errors were no longer reported.
- Final targeted recheck after further concurrent edits: `npm run desktop:typecheck` passed; all 25 tests in `desktop-studio-flow.test.ts` passed.
- Focused composer/Studio/brain suites: 13 files; 125 tests passed and 1 failed. The failure is the Studio board fallback test described above.
- Full repository run: 165 files; 163 passed, 1 failed, 1 skipped. Tests: 1,558 passed, 1 failed, 3 skipped. Its sole failure was the earlier Studio fixture mismatch. That file was loaded before the concurrent fix; the later targeted rerun passed all 25 tests. The entire suite was not rerun against the final changing working tree, so these results should not be described as an all-green final-revision run.
- The full run also emitted `node-pty` helper `AttachConsole failed` errors while the six terminal tests themselves passed. Investigate that Windows helper noise separately; it was not a Vitest assertion failure.
- No installed-app or live-provider validation was performed; visual quality, actual retrieval relevance, large-project performance, and packaged release behavior remain unverified.
