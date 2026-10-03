# KAI composer: intelligence upgrade plan

Scope: `apps/desktop` Direct API path (`main/direct-provider-runtime.ts`, `main/project-tools.ts`, `main/ipc.ts`)
and the composer UI (`renderer/src/components/Workspace.tsx`). Goal: close the gap between the composer's own
agent loop and Claude Code's, in the four areas identified by inspection (2026-10-03).

Status as of 2026-10-03: items 1-4 implemented below. `desktop:typecheck` clean; full `desktop:test` suite green (1503 passed, 3 pre-existing skips), including new tests for the turn digest, `ask_user`, and `explore`.

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

## Deferred (not in this round)

- Plan-mode "approve, then execute" handoff.
- Live thinking display / sending reasoning back between rounds.
- Parallel tool execution and background long-running commands.
- Edit-capable (not just read-only) sub-agents.
