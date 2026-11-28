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
- Workspace keeps the development Lead; Learn & Code keeps its teaching panels and Guided Build. Studio opens Workspace with Lead and the plan visible.
- New idea flow: Approve, Change or Park; one plan; protect finished steps; write nothing before approval.
- Long `DESIGN.md` files: send relevant sections and report omissions.
- Fix the failing tutor test in `test/desktop-learning.test.ts`.
- Verify in the running app with a local and a cloud model, including restart.
- When complete, list changed files and propose commit messages. Wait for the developer.

Status: PARTLY COMPLETE (2026-11-26). Lead code paths, tutor test, and screen loading were checked. Targeted tests, the full Vitest suite, and desktop typecheck pass. Local/cloud live replies and Studio handoff action were not exercised. Screenshots were captured. No commit or push.

### Approved Workspace follow-through (2026-11-28)

- Reuse the Workspace editor for Conversation / Code views and Follow Builder. Keep the composer fixed, show actual edits, and pause following for manual inspection or unsaved changes.
- Return linked Builder outcomes to Lead automatically. Treat Passed, Needs repair, Not checked and Needs you as task evidence states; never close a phase because a model says it is complete.
- Save task evidence and blockers with existing conversations. The existing Studio board or spec plan stays authoritative; do not introduce a second planner or overwrite project plans.
- Reuse the role controls for a separate optional reviewer. Paid automatic review requires explicit opt-in and leaves the Lead's local/cloud selection unchanged.
- Bound new automatic cycles by task count, repair attempts, repeated failure and spend. Recheck project/session, settings and file hashes after waits. Do not replay completed work when reopening history.
- Lead access is separate from Builder handoff: Read-only by default, Ask before edits for one small exact diff, or Plan edits allowed for existing completion steps backed by current Passed evidence. Code, decisions, scope, verification baselines and reopening finished steps still need approval. Preserve intervening edits and ask again after a refreshed preview. Model tools remain read-only; KAI applies the approved correction. Existing Studio acceptance gates still apply.
- Blockers limit affected work, not planning or unrelated progress. Lead must offer a recovery task, an exact decision, or an existing independent step with its dependencies explained. **Plan ways forward** remains available for manual recovery, including stopped results. One automatic recovery-planning reply is allowed within current model/cycle limits; it cannot accept failed work, replay a run, invent dependency independence or automatically dispatch its proposal. Recovery tasks require approval. Discuss high-risk options freely; approval is needed before acting on high-risk assumptions.
- Verify targeted tests, desktop typecheck, themes and rendered/running screens. Record any live-model verification gaps. No commit, push or install as part of this implementation.

Status: IMPLEMENTED; LIVE-MODEL VERIFICATION PARTLY COMPLETE (2026-11-28). Targeted suites pass (320 passed, one optional installation test skipped), desktop typecheck and production build pass. An isolated Electron smoke with a deterministic local provider exercised two real Builder edits and project checks, Lead review and next-step continuation, saved results after restart without replay, protected editor drafts, fixed Lead input and light/dark narrow/wide layouts. Real local/cloud inference and native CLI editor-follow behavior still need live verification. Task outcomes do not sign off phases or overwrite the authoritative plan. No commit, push or install.

Lead access extension (2026-11-28): implemented and covered by 24 service tests plus rendered selector/approval interactions. Targeted regression suites: 345 passed, one optional installation test skipped; IPC and contract checks: 27 passed. Typecheck and production build pass. An isolated Electron test used the read-only model channel to propose a real correction, verified no write before approval, applied the exact preview and retained it across restart without changing the Builder draft or starting Builder. This extension has not been installed. Real local/cloud inference and native CLI behavior remain unverified.

Review price-pause fix (2026-11-28): unknown paid usage now records a recoverable task notice instead of failing Lead chat. One explicit review remains available; unknown spending still blocks automatic paid continuation. Normal chat clears stale error text. Seven targeted suites (101 tests), desktop typecheck and styled narrow/wide rendered checks pass. This fix has not been installed or exercised with a real paid provider.

Installation update (2026-11-28): the developer requested a local rebuild/install of the Lead-access extension and review price-pause fix. Production build and Windows packaging passed; all 9,174 installed files matched the build, and the installed app relaunched. Version remains 1.2.48. No commit or push. Live-provider verification remains pending the developer's testing.

Blocker-recovery extension (2026-11-28): implemented in source, not installed. Lead offers concrete recovery options and independent planned work; blocked result cards offer Plan ways forward. Automatic recovery planning is bounded and never dispatches its proposal without approval. Targeted checks: 25 suites, 388 passed and one optional installation test skipped; desktop typecheck and production build pass. Isolated Electron checks demonstrate an open verification gate, a recovery proposal, usable follow-up chat and restart without replay. Real model inference quality and automatic proof of independent dependencies are not claimed; uncertain recovery tasks require approval.

Latest installation update (2026-11-28): compact Lead controls and blocker recovery were rebuilt, packaged and installed locally at the developer's request. All 9,174 installed files matched the build, and KAI relaunched successfully as version 1.2.48. Saved app data was preserved. No commit or push; real-provider testing remains with the developer.

Builder-output follow-up fix (2026-11-28): implemented and installed locally at the developer's request. Every Lead request reloads the latest linked Builder records and budgets their actual replies and command output alongside the whole question, specs and open file. Recorded Git commands remain visible without being treated as passed tests. Whole-section omissions and source timestamps are disclosed; existing redaction is reused. Checks: 26 suites, 396 passed and one optional installation test skipped; typecheck/build pass. Isolated Electron assertions verify actual Builder/Git evidence on continue before and after restart, without replay or extra Builder work. Production build and Windows packaging passed; all 9,174 installed files matched the build, and the installed app relaunched as version 1.2.48. Saved data was preserved. No commit or push. Real-provider quality remains unverified.

Lead inspection and live-code correction (2026-11-28): implemented in source; not installed. Saved-run inspection confirmed repeated reads after tool-result compaction. Lead now detects unchanged overlapping reads across a run and answers using its existing evidence before folding or exceeding a bounded inspection budget. Builder completion reloads the saved result, waits if Lead is busy, and keeps review actions visible when a newer task is only a draft. Code view reuses the project watcher for actual disk changes, follows verified live diffs, highlights changes on first open and supports Previous/Next touched-file navigation. Checks: 29 suites, 417 passed and one optional installation test skipped; desktop typecheck and production build pass. An isolated Electron check verified active edit following, highlights, navigation, two automatic Builder-to-Lead reviews, protected drafts, themes, pane widths and restart without replay. Real local/cloud inference and native CLI interaction remain unverified. Unknown paid usage still pauses automatic paid work; explicit manual review remains available. No commit, push or install; remain in Stage 1.

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
