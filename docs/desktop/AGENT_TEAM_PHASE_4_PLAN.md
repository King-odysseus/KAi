# Goal: finish the agent team (Phase 4 and follow-ups)

You are implementing this in the KAI desktop app (`apps/desktop`, Electron + React, contracts in `packages/contracts`).
Work through the tasks in order. When all are done and verified, stop and write the report described at the end.
Another agent will review your work before anything is committed.

## Ground rules

- **Do not commit, push, build an installer or install.** Leave every change in the working tree for review.
- **Do not touch** `apps/desktop/src/main/learning-tutor.ts`, `apps/desktop/src/renderer/src/components/LearningPanel.tsx`
  or `test/desktop-learning.test.ts` except where Task 4 says so. They hold unrelated uncommitted work.
- **Lint rule is "no new problems"**, not a clean run: `src/` has a large pre-existing baseline. Check that nothing
  you add or change introduces a new ESLint problem. Do not add eslint-disable comments to pass.
- **Never delete or skip a failing test** to get green. Fix the code, or explain in the report why a test was wrong.
- Match the surrounding code: plain-words comments explaining *why*, no comment noise, contracts validated with zod
  (`.strict()` objects), pure logic in small modules with unit tests.
- Windows is the main platform. Tests that spawn git or node need `vi.setConfig({ testTimeout: 90_000 })` or more.
  Compare temp paths with `fs.realpath` (8.3 short names).
- In smoke scripts, never pass an async function to `page.waitForFunction`: it returns immediately. Use
  `waitForPage` from `apps/desktop/scripts/smoke-helpers.mjs`.
- Every UI control must stay on one line. The smoke tests enforce this through `assertControlsDoNotWrap` and
  `assertTogglesCompact` in `apps/desktop/scripts/layout-checks.mjs`. Run them on any screen you change.

## How the agent team works today (read these first)

- `packages/contracts/src/team.ts`: roles, custom roles, `resolveRole`, `roleConfigFor`, `stepAccess`, `planWaves`,
  team settings schema and the plan, assignment and start schemas.
- `apps/desktop/src/main/team-assign.ts`: who does each part (`assignTeam`, `resolveOrchestrator`). Auto scores
  agents with the `STRENGTH` table and the preset.
- `apps/desktop/src/main/team-plan.ts`: orchestrator prompt, plan parsing, guardrails (added reviews), step prompts,
  `routeFailure` / `buildFixPrompt` for failed checks.
- `apps/desktop/src/main/team-planner.ts`: plan and start a team job; the per-project team override.
- `apps/desktop/src/main/workflow-runner.ts`: runs a job. `runStep` (one step, in place or in a separate copy),
  `executeWaves` (side-by-side waves), `verifyTeam` (check command, then fix rounds by the owning part), the security
  gate, Stop and Resume. Job updates go through `mutate` (a per-job lock).
- `apps/desktop/src/main/git-worktrees.ts` and `parallel-session.ts`: snapshot, worktrees, merge, safe apply.
- UI: `components/TeamPanel.tsx` (goal, plan card, run options), `components/TeamSettings.tsx` (team card, custom
  roles, project scope), `components/Pages.tsx` (Workflows page and run view).
- Tests: `test/desktop-team.test.ts`, `test/desktop-workflows.test.ts`, `test/desktop-git-worktrees.test.ts`,
  `test/desktop-parallel-session.test.ts`. End to end: `apps/desktop/scripts/smoke-team.mjs` (fake CLIs on PATH, a fake
  LM Studio server, a real git repo for the side-by-side step).

## Task 1: review again after a fix round

Today, when the check fails and a part runs a fix round, the security and code reviews do not run again, so the fixed
code is never reviewed.

- After a fix round's steps finish, and before the check runs again, add a fresh copy of each review step that ran in
  the job (security reviewer and code reviewer, plus any custom read-only role), marked with the same `round`. Each
  new review depends on the fix steps of that round, sees their output through the existing hand-off, and is told in
  its prompt that it is re-reviewing only what the fix round changed.
- The security gate applies to these re-reviews exactly as to the first review (block pauses and asks).
- Respect the 50-step workflow limit: if adding re-reviews would exceed it, pause with a clear notice instead.
- Tests in `desktop-workflows.test.ts`: a failed check leads to fix, then re-review, then check again; a re-review that
  blocks pauses the job; a job without reviews adds none; the step limit is respected.

## Task 2: cheaper re-run after a merge clash

Today a part whose changes clash in a side-by-side wave re-runs its whole task from scratch.

- Keep the clashing part's commit (it is already created in its worktree). When it re-runs on its own, give it the
  diff of its previous attempt (`git diff <snapshot> <its commit>`, trimmed to about 8,000 characters, with a note when
  trimmed) and tell it to re-apply the same intent on top of the current project, resolving the clash, rather than
  redoing the task.
- Add what you need to `ParallelSession` / `parallel-session.ts` (for example returning each clashing part's diff from
  `integrate`) and store it on the step (a new optional field in the workflow step schema, trimmed).
- Tests: real-git test that a clash returns the part's diff; runner test that the re-run prompt contains it.

## Task 3: clean up leftover copies on startup

A crash can leave worktrees under `os.tmpdir()/kai-parallel` and registered in the project's git.

- On app start, for each known project that is a git repo, run `git worktree prune` and remove any registered worktree
  whose path is under the `kai-parallel` folder and is not used by a running job (none are running at startup).
  Then delete leftover folders under `kai-parallel` older than one hour. Never touch anything outside that folder, and
  unlink a linked `node_modules` before deleting a folder (see `removeWorktree`).
- Must not slow startup: run it in the background after the window shows, log what was removed.
- Tests with real git: a stale registered worktree is removed; a folder outside `kai-parallel` is never touched;
  the project's `node_modules` survives.

## Task 4: rewrite the three stale tutor smoke checks

`apps/desktop/scripts/smoke-workbench.mjs` skips `verifyTutorCollapsibleSections`, `verifyTutorCompactControls` and
`verifyTutorInlineCompletion` when `KAI_SKIP_STALE_TUTOR_CHECKS=1`, because they describe the tutor panel from before
its redesign. Rewrite them against the current `LearningPanel.tsx` (read it; do not change it), keeping each check's
intent (sections collapse and expand, controls are compact and do not wrap, inline completion appears and is
accepted). Then remove the skip flag so the workbench smoke runs everything. `npm run desktop:smoke:workbench` must pass.

## Task 5 (main): learn which agent does best at each role

KAI should keep a local track record per agent and role, and use it to suggest better team choices. It must never
change the user's pinned choices by itself.

### What to record
When a team job finishes, is stopped, or pauses, record one entry per completed or failed part (not reviews of reviews)
into a new store under the app data folder (follow the pattern of the existing JSON stores, e.g.
`project-preference-store.ts`; atomic writes, schema-versioned, capped at the most recent 5,000 entries):
`projectId, role, custom (bool), assignee (agent id or "api"), route, model?, startedAt, durationMs, costUsd?,
outcome ("completed" | "failed"), neededFix (bool: a fix round ran for this part), blockedByReview (bool: a security
review of this job blocked), overridden (bool: the user changed KAI's suggested agent for this part on the plan card)`.
To know `overridden`, keep KAI's original assignment on the step when the plan is started.

### How to score
A pure module (`apps/desktop/src/main/team-record.ts` or similar, fully unit tested):
- Per (scope, role, assignee): `jobs`, `successRate` (completed without a fix round and not blocked), median duration,
  total cost.
- Scope: the project's own record once it has at least **5** entries for that role and agent; otherwise the record
  across all projects. Nothing is suggested below 5 entries per agent and role.
- A suggestion for a role exists only when another ready agent's success rate beats the current choice's by at least
  15 points with at least 5 jobs each. Include the numbers in plain words, e.g. "Qwen passed first time in 8 of 9 test
  jobs here; Claude in 4 of 7."

### Where it shows
- Settings, Agent team card: under each role, a one-line track record ("Codex: 9 jobs, 8 passed first time, about 4
  min each") and, when there is one, the suggestion with **Use Qwen** and **Dismiss** buttons. Use changes only that
  role's choice in the draft (the user still saves the card). Dismiss hides that suggestion until the numbers change.
- Plan card: a part's reason line may add the agent's record ("passed first time in 8 of 9 jobs here").
- Auto: when two ready agents score within 1 point of each other in `scoreFor`, prefer the one with the better
  recorded success rate for that role. It is a tie-breaker only; it must never override a pinned role or a preset
  penalty, and with no record Auto behaves exactly as today.
- A **Clear track record** button (confirm first) in the team card.

### Tests
Unit tests for recording, scoring, scopes, thresholds, the tie-breaker (including that it never overrides a pin and
changes nothing without a record), and the store (atomic, capped, tolerates a missing or corrupt file). Extend
`smoke-team.mjs`: after the jobs it already runs, the team card shows a track record line.

## Verification (all must pass before you finish)

```
npm run desktop:typecheck
npm test
npm run desktop:build
npm run desktop:smoke
npm run desktop:smoke:team
npm run desktop:smoke:workbench
```

The first smoke run right after a fresh build occasionally times out on a navigation button while the fake CLIs
start; rerun once before treating it as a failure. Report any test you could not run and why.

## Report (your final message)

1. What you changed, per task, with the main files.
2. Anything you decided that this plan did not specify, and why.
3. Anything not done or not working, honestly.
4. The verification results (counts, pass or fail), and ESLint problems on lines you changed (there should be none).
