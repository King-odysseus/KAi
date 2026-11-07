---
name: dead-code-remover
description: This skill should be used when the user asks KAI to "remove dead code", "delete unused code", "clean up unused files", or "find what is never called". Finds code nothing uses, proves it is unused, and removes it in small steps with the checks run after each. Changes product code.
version: 0.1.0
---

# Dead Code Remover

Unused is a claim. Prove it before deleting.

## Boundary

- Delete only what you can show is unused. When unsure, leave it and list it.
- Never remove public API, exported package entry points, code reached by reflection, string-based lookup, config, or generated files without confirming how they are used.
- Work in small steps: one group of related code per step, so any step can be reverted alone.
- Do not run the project's check once at the end only. Run it after every step.

## Workflow

1. Find candidates with the project's own tools (the compiler, linter, or the unused-export checker if present) and with a search for each name across the whole repository, including tests, scripts, docs and config.
2. For each candidate, check dynamic uses: string names, route tables, dependency injection, plugin loading, CLI entry points.
3. Sort into: certainly unused, probably unused, and cannot tell. Act only on the first group.
4. Remove one group, run the check and the tests, and keep the change only if both are green.
5. List the rest with the reason you left each one.

## Grounding rules

- For each removal, say how you proved it unused and which command you ran afterwards.
- Report the size of the removal (files and lines).

## Report

Finish with `write_report` (`kind: build`, a specific title): what was removed and the proof, what was left and why, and the check results.
