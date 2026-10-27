# Claude and Codex workflow improvements for KAI

Created: 26 October 2026. This plan translates the product comparison into small KAI increments. KAI already has skills, hooks, schedules, worktrees, checkpoints, queued prompts, live preview, AI change review, and criterion-level completion evidence; work should connect and improve those flows rather than duplicate them.

## Goal

Make a coding task easy to start, steer, verify, review, and resume across KAI's supported agents. Keep execution agent-neutral and keep consequential actions under user control.

## Phases

| Phase | Outcome | Status |
|---|---|---|
| 1. Actionable review | Findings open their source and can be turned into a focused fix request; the user reviews and sends that request. | Implemented |
| 2. One task trail | Connect composer request, goal, Studio card, conversation/run, changed files, checks, review decision, and lesson draft with navigable links. Reuse current IDs and stores before adding a new task database. | In progress |
| 3. Context and continuity | Record per-run project-context sources and truncation; improve persistent CLI sessions where the harness supports them, with capability-aware fallbacks. | In progress |
| 4. Review to delivery | Add inline review comments and follow-up handling, then surface GitHub PR and CI state where integrations are configured. Keep merge actions explicit. | Planned |
| 5. Remote supervision | Make approvals, blocked questions, changed-file summaries, checks, and review findings easy to handle from KAI mobile. | Planned |
| 6. Integrated project overview | Bring active tasks, blockers, current checks, review, preview, and recent memory into a resumable project view. | Planned |

## Phase 1 implementation

- Add an Open file action to each AI review finding.
- When a finding includes a line number, open the file with that line centered in the editor.
- Add an Ask KAI to fix action that prepares a Build prompt containing the original request and the specific finding.
- Keep the prompt editable and require the user to send it; selecting a finding must not start edits automatically.
- Preserve the existing review result and activity timeline so the finding remains traceable to the run.

## Completion criteria

- A finding with or without a line number can open its file in the active project; numbered findings center the relevant line in the editor.
- The fix action puts a scoped prompt in the composer and selects Build intent.
- The prompt names the review finding and asks KAI to implement and verify the smallest appropriate fix.
- The user can inspect and edit the prompt before execution.
- Existing review behavior and unrelated composer state remain intact.

## Follow-up acceptance criteria

- A single task can be followed from its original request through all runs, evidence, review findings, and memory draft.
- Review comments can be addressed individually, and users can see which findings were resolved or remain open.
- Context inspection matches what was actually sent, including included and truncated sources.
- Agent-specific interaction limits are visible before send and after interruptions.
- Mobile supervision exposes meaningful decisions without trying to reproduce the desktop workspace on a small screen.

## Phase 2 implementation

- Studio-origin conversations expose their source card in the workspace.
- Opening that link switches to the matching Studio project, selects the Board tab, and scrolls the source card into view.
- The link uses the existing conversation origin (`studioProjectId` and `cardId`); it adds no duplicate task storage.
- Missing projects or cards produce a visible message rather than silently opening a different board.
- Each new Autopilot card run stores its conversation ID with the existing run record; the card shows changed files and can reopen that conversation. Older run records remain readable.
- The board card keeps its current status, criterion evidence, and verification run ID beside the run history, so the run and its outcome are visible together.
- Expanding run history loads each linked conversation’s C1 lesson event and asks C1 for the durable review state: pending, approved, or rejected. The conversation ID is embedded in the lesson so the link survives queue renumbering and final review; older lessons or removed entries without a recorded decision are identified as unavailable rather than guessed.
- The lookup requires the new C1 draft-status endpoint; when C1 is offline or has not been updated, Studio keeps the filed event visible and reports the live review state as unavailable.

## Phase 3 implementation

- Each new run saves the project-context sections built for that run as a `context.snapshot` event in its conversation, including source labels, truncation markers, character/token estimates, and delivery mode. It also records selected skill names and composer attachment sources without copying attachment contents.
- The transcript renders the snapshot as a disclosure beside the run, so later project changes do not rewrite the source list for an earlier run.
- If a resumed CLI explicitly reports that its session is missing, expired, or invalid before producing output, KAI retries once in a fresh session with a conversation handoff and full project context. The retry is announced in the transcript; unrelated failures and partial runs are not retried.
- The transcript disclosure includes the captured project-context text for inspection; it is capped at two million characters per run, with a visible cap indicator. Provider-managed system prompts and resumed CLI session history are outside the record. The existing side panel remains a current approximate preview.
- Composer attachment contents are not copied into this snapshot; their source labels are listed, and the attachments remain visible in the original user turn.
