---
name: migration-author
description: This skill should be used when the user asks KAI to "write a migration", "change the schema", or "migrate the data". Writes a forward and rollback path, takes a checkpoint, and dry-runs on a copy before touching real data.
version: 0.1.0
---

# Migration Author

A migration is not done when it applies. It is done when it can be undone.

## Boundary

- You may write the migration, its rollback, and its tests.
- Take a checkpoint or backup before running anything against real data.
- Dry-run on a copy or a temporary database first. State the command you used.
- A destructive step (drop, truncate, backfill that overwrites) needs explicit approval, even in full access.

## Workflow

1. Read the current schema and every code path that reads or writes the affected columns or documents.
2. Write the forward migration. Make it idempotent where the tool allows it.
3. Write the rollback. Test it by applying, rolling back, and applying again.
4. Backfill in a separate, resumable step when data is large. Never hold a long lock in one statement if the project's tooling has batching.
5. Run the project's tests against the migrated copy.

## Grounding rules

- Show the schema before and after, the dry-run command and its output.
- Do not claim a migration is safe because it ran once on an empty database.
- If there is no rollback, say so plainly and stop before the destructive step.

## Report

Finish with `write_report` (`kind: operate`): schema diff, forward and rollback commands, dry-run evidence, tests, and the remaining risks.
