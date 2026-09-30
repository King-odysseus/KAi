# KAI desktop: agent improvement plan

Scope: `apps/desktop` only. Each item is independently shippable and has its own targeted tests.
Status as of 2026-09-30: every item below is implemented; notes say what is and is not covered.

## Round 1

1. **Stop re-sending static context on resumed CLI turns.** A resumed CLI session already holds the ~18 KB
   Cognitive1 rules, the project instruction files and the skills list from its first turn. Resumed turns now
   send only what changes. `main/context-builder.ts` (`omitStatic`), `main/ipc.ts`.
2. **Prompt caching for direct Anthropic runs** (`api.anthropic.com` only), with cache tokens counted in usage.
   `main/direct-provider-runtime.ts`.
3. **Checkpoints that survive untracked and binary files.** Tree snapshots via a temporary index; raw-byte
   restore; old checkpoints still restore. `main/checkpoints.ts`. Non-git folders still get none.

## Round 2

4. **Repository map** in the direct-API context (`main/repo-map.ts`): source files and what they declare, cached
   for 60 s, shortened to fit ~8 KB. Regex-based per language, not a full parser.
5. **Auto check-and-fix loop** (`main/automation.ts`): after a run that edited files, run the project's check
   and send failures back to the agent, up to N rounds. Opt-in per project.
6. **More direct-API tools** (`main/project-tools.ts`): `list_files`, regex/glob `search_files`, `multi_edit`
   (all-or-nothing), `write_file`, `move_file`, `delete_file` (asks unless Full access). MCP tools were already
   offered to direct runs. Also fixed `$&`-style patterns being interpreted in `replace_in_file`.
7. **Spend cap and loop detection** (`main/run-guard.ts`): $5 per run by default (`KAI_MAX_RUN_COST_USD`),
   warn at 3 and stop at 5 identical call-and-result repeats.

## Later items

8. **Scheduled goals** (`main/scheduler.ts`): daily or interval, plan (read-only) or full access, one at a time,
   runs while KAI is open and catches up once. Settings, Project automation.
9. **Project hooks** (`main/automation.ts`): `beforeRun` (can block, output goes to the agent), `afterEdit`,
   `afterRun`. Stored in user preferences, never in the repository.
10. **Agent scorecards** (`main/run-scores.ts`): every interactive run is scored; a poor record at a work level
    sends that work one level up in `autoCliModel`.
11. **Evals** (`main/evals.ts`): save a task and a check command, replay on any agent from the same commit in a
    disposable worktree.
12. **Review before done** (`main/change-review.ts`): a second model reads the diff against the request and adds
    a short verdict to the conversation. It reports; it does not block a board card.
13. **`kai` command** (`resources/kai-cli/kai.mjs`, `main/headless.ts`): `kai run "prompt" --project . --agent codex`.
    Job and result travel through KAI's own temp files. Unit-tested; not launched against a real Electron process.
14. **Shared run scaffolding**: the spend cap and repeat guard sit in the one `executeToolCalls` and the one
    per-round check that all four provider loops already share, rather than a rewrite of the four loops.
