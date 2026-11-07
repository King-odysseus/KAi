---
name: safe-schema-change
description: This skill should be used alongside a migration when the user asks KAI to "change the schema safely", "rename this column", "add a required column", or "migrate without downtime". Plans the change as small backward-compatible steps (expand, migrate, contract) so old and new code both keep working. Planning and migration files only.
version: 0.1.0
---

# Safe Schema Change

Never change the database and the code in one step. Make every step safe to run on its own.

## Boundary

- Write migration files and a plan. Do not run a migration against real data. Dry-run on a copy only.
- Never drop a column, table or constraint in the same release that stops using it.
- Do not change a type or add a required column in a way that locks or rewrites a large table without saying so.

## Workflow

1. State the end state and what the current code reads and writes.
2. Break the change into steps that are each safe with both the old and new code running:
   - **Expand:** add the new column, table or index, nullable or with a default, without removing anything.
   - **Write both:** change the code to write the old and new shape.
   - **Backfill:** fill the new shape from the old in batches, with a way to resume.
   - **Read new:** switch reads to the new shape once the backfill is verified.
   - **Contract:** in a later release, remove the old shape.
3. For each step give the forward migration, the rollback, and a check that proves the step worked (a count or a query).
4. Flag steps that lock tables, rewrite data, or cannot be rolled back, and what to do about them.
5. Dry-run the steps on a copy of the data if one exists, and report the result.

## Grounding rules

- Name the real tables and columns from the project, not examples.
- State plainly what you could not test without real data or a real database.

## Report

Finish with `write_report` (`kind: plan`, a specific title): the steps in order with forward, rollback and verification, the risky steps, and the dry-run result.
