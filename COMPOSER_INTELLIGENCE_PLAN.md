# KAI composer: intelligence upgrade plan

Scope: `apps/desktop` Direct API path (`main/direct-provider-runtime.ts`, `main/project-tools.ts`, `main/ipc.ts`)
and the composer UI (`renderer/src/components/Workspace.tsx`). Goal: close the gap between the composer's own
agent loop and Claude Code's, in the four areas identified by inspection (2026-10-03).

Status as of 2026-10-03: items 1-5 implemented below. `desktop:typecheck` clean; full `desktop:test` suite green
(1503 passed, 3 pre-existing skips), including new tests for the turn digest, `ask_user`, and `explore`. Items
1-4 are committed (`ed9d4e2`). Item 5's `main/ipc.ts` and `packages/contracts/src/domain.ts` pieces are committed;
its `Workspace.tsx` piece (the answer box under a turn) is correct and working on disk but **not yet committed**
— `apps/desktop/src/renderer/src/components/Workspace.tsx` was mid-rewrite by a concurrent session (a composer
queue/steering feature) at the time, and splicing one more change into that diff by hand risked corrupting
either piece. Whoever next commits a clean `Workspace.tsx` should confirm the `AnswerBox`/`awaitingAnswer`
wiring (search for `awaitingAnswer`) is still intact and include it.

## 1. Carry what earlier turns *did*, not just what they said

Previously `DirectApiHistoryTurn` was `{ role, text }` and the saved assistant turn was the closing prose only
(`ipc.ts:1595`), so a follow-up message had no idea which files were read, what ran, or what came back.

- `main/turn-digest.ts` (new): builds a short digest from a turn's `PersistedEvent[]` — files read/edited/created,
  commands run (with exit status), and the plan state at the end of the turn.
- `ipc.ts`: each `ConversationTurn` gains an optional `toolDigest` field, filled in when the turn's execution
  finishes. `apiHistory` now sends `${text}\n\n[What this turn actually did]\n${toolDigest}` for assistant turns
  that have one, instead of the bare reply text.

## 2. One working-method system prompt

Added `main/working-method.ts`: a short, fixed briefing — look before you change, narrate before a long
stretch, verify before declaring done, finish with a fixed-shape report (what changed, what was verified, what
is left). Sent once per run (prepended the same way `execution-rules.ts` sends the standing rules), not
per-turn, so it does not grow the request.

## 3. `ask_user` tool with clickable options

- `main/project-tools.ts`: new `ask_user` tool definition — `question: string`, `options: string[]` (2-4),
  `allowFreeText: boolean`. Always `{ decision: 'allow' }` in policy (it only asks a question, same footing as
  `update_plan`).
- Execution raises the existing `DirectApiApprovalPort`/`approval.request` event, carrying `options` on the
  approval record (new optional field, additive to `approvalRequestEventSchema`), and resolves with the chosen
  option's text (or free text) as the tool's output rather than a boolean.
- `Workspace.tsx`: the approval card renders option buttons when `options` is present, instead of
  Allow/Deny.

## 4. Read-only explorer sub-agent

- `main/project-tools.ts`: new `explore` tool — `question: string`. Runs a nested, bounded loop (read_file,
  search_files, list_files only; no edits, no commands, no further `explore`) against a *fresh* context (no
  conversation history), using the same provider/model as the parent run, and returns a short text answer. The
  parent run keeps only that answer, not the intermediate reads.
- Guarded: max 1 level of nesting (the nested loop's tool policy excludes `explore` itself), a tool-round cap
  separate from the parent's, and its own slice of the parent's cost guard so it cannot bypass the spend cap.
- `Workspace.tsx`: an `explore` tool call renders as "Explored: <question>" with the answer, collapsed by
  default, like other grouped tool calls.

## 5. Surface a trailing question instead of letting it look like idle completion

Added 2026-10-03, after confirming `ask_user` and `explore` cannot reach the CLI agents: both are KAI's own
Direct API tools, and every CLI is invoked with `-p` (one piped, non-interactive turn per invocation; see
`agent-runtime.ts`), so there is no live channel into a CLI turn for KAI to push an answer back through mid-run.
Building one would mean switching every CLI's invocation to a persistent stdin/stdout protocol (where one exists)
and handling each CLI's own permission-callback shape — a new architecture, not an extension of `ask_user`.

What *is* feasible, and applies to both the CLI and the API path alike: when a completed run's own words end in a
genuine question (`awaitsTheUser`, already used to stop the API loop from nudging a real question), the assistant
turn is marked `awaitingAnswer` (`packages/contracts/src/domain.ts`). The composer (`Workspace.tsx`) renders a
small reply box under that turn; answering it calls the same `queueOrSend` a typed message would, which resumes
the conversation. This does not reopen the run that asked — it cannot — it only makes the question impossible to
miss and turns the reply into a one-click resume instead of the person having to notice it themselves and retype
it into the composer below. `main/ipc.ts` sets the flag only for a `completed` run whose own output (not the
synthesized `describeRunOutcome` fallback) is the question.

## Deferred (not in this round)

- A persistent, mid-turn channel into a CLI agent, which `ask_user` for CLIs and a true live `explore` for CLIs
  would both need. Scoping it further needs a decision on which CLIs' own protocols actually support a
  stay-alive session (Claude Code's does, under `--input-format stream-json`; not confirmed for the others).
- Plan-mode "approve, then execute" handoff.
- Live thinking display / sending reasoning back between rounds.
- Parallel tool execution and background long-running commands.
- Edit-capable (not just read-only) sub-agents.
