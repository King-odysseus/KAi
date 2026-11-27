# Next Round Plan

Work one stage at a time. Report Done / Partly / Not done with evidence, tests, typecheck, screenshots, what could not be verified, and decisions needed. Stop after each stage until the developer says continue.

## Rules

- Follow `docs/desktop/LEAD_AND_BRAIN_PLAN.md` ground rules.
- Inspect existing work first; complete it without duplication.
- Do not commit, push, install or approve design profiles without explicit instruction.
- Before changing brain or app data: make a backup, show a dry run, and wait for approval.
- Keep saved conversations, runs and settings loadable.
- Never kill Electron by process name.
- Never link or junction a temporary worktree's `node_modules` to another folder. Use a separate dependency install for each temporary worktree. Ask before deleting any folder, and never recursively delete a folder that may contain links.
- When touching a very large file, extract the part being changed without behavior changes and add tests.

## Stage 1: Finish and verify current work

- Lead panel: errors, questions, approvals and Stop; save full questions; budget question + spec files + open file together; include goal summary only on start or Studio handoff; composer-style input; show Runs on, Provider and Model selectors with all configured options saved by identity; Send to Builder sends only the task and asks before replacing a draft.
- One Lead in Workspace and Learn & Code; Studio opens Workspace with Lead and the plan visible.
- New idea flow: Approve, Change or Park; one plan; protect finished steps; write nothing before approval.
- Long `DESIGN.md` files: send relevant sections and report omissions.
- Fix the failing tutor test in `test/desktop-learning.test.ts`.
- Verify in the running app with a local and a cloud model, including restart.
- When complete, list changed files and propose commit messages. Wait for the developer.

Status: PARTLY COMPLETE (2026-11-26). Lead code paths, tutor test, and screen loading were checked. Targeted tests, the full Vitest suite, and desktop typecheck pass. Local/cloud live replies and Studio handoff action were not exercised. Screenshots were captured. No commit or push.

## Stage 2: Autonomous Crew (partly started; do not continue until Stage 1 is complete and the developer says continue)

Status: PARTLY STARTED (2026-11-26). Existing Crew changes are in the working tree, and the no-detected-check test was fixed and run while completing Stage 1. The review, check-command, checklist, task-splitting and escalation changes have not had a dedicated Stage 2 verification pass. The Stage 1 evidence report contains the Crew working-tree change inventory and test evidence.

- Failed or unreadable reviews never pass: retry, use a backup reviewer, otherwise mark unchecked, block dependants and phase completion, continue unrelated work, and retry later. Display old `Not checked` accepts as unchecked.
- Detect and baseline a check command; run it per task; require tests.
- Give builders a pre-submit checklist for ownership, input limits, secrets and session rechecks; require evidence for every criterion.
- Keep tasks small and named by files; attach relevant complete functions.
- After two failures with the same cause, split or escalate within developer limits.
- Park work needing the developer while independent tasks continue.
- Check each reviewer returns a readable verdict before starting.

## Stage 3: Proof everywhere

- Label runs Checked, Failed or Not checked in composer, Lead builds and Crew.
- Offer a detected check command when a project is first opened.
- Add automated smoke tests for sending a message, asking the Lead, building a change and running Crew.

Pause after Stage 3 for the developer's 10 real tasks and notes.

## Stage 4: Brain health (includes the separate memory service)

- Block repeats at write time, retire outdated notes, record sources, show and remove recalled notes, and warn when repeats grow.

## Stage 5: Local models

- Add “Test this model” using a small real edit in a throwaway copy. Report pass/fail, speed, tool use, context size and suitable roles.

## Stage 6: Safety

- Ask before risky actions, especially for local models. Do not silently change saved settings.
- Test that the Lead cannot edit files with any provider or CLI agent.
- Find why `credentials.vault.json.*.tmp` files remain in KAI's data folder, fix the cause, and propose safe cleanup. Never print their contents.

## Stage 7: Simpler app (mockup first; wait for approval)

- Daily choices are Plan, Build and Team; the rest goes under More. Delete nothing.

## Stage 8: Remaining plan work

- Finish Phases 4–8 of `LEAD_AND_BRAIN_PLAN.md`: project map, small task cards, Lead Just run / Guide me / I type modes, explain-back, scoreboard and top-three UI picker. Do one at a time.
