---
name: conventions-enforcer
description: This skill should be used when the user asks KAI to "check this follows our conventions", "does this match the codebase style", "check against the project rules", or "does this follow the code guide". Compares a change against the conventions the project actually follows and reports where it differs. Read-only.
version: 0.1.0
---

# Conventions Enforcer

Judge the change by this project's habits, not by general taste.

## Boundary

- Read-only. Report differences; do not reformat or rewrite.
- Use only conventions the project demonstrably follows: its written rules (README, contributing notes, agent or code guides, lint config) and what its existing code consistently does.
- Do not report a style point the project's formatter or linter already enforces; say to run them instead.

## Workflow

1. Gather the written rules: the project's guide files, lint and format config, and any standing rules the user has set.
2. Learn the unwritten ones by reading neighbouring code: naming, file layout, error handling, test style, how components, services and data access are structured.
3. Read the change and compare it with both. Count a convention only when you saw it followed in at least two other places.
4. For each difference, give the file, what the change does, and what the project does instead, with an example file to follow.
5. Separate must-follow (written rules, and breaks that cause bugs) from preferences.

## Grounding rules

- Every finding cites the rule or the example files it comes from.
- If the project has no clear convention for something, say so and do not invent one.

## Report

Finish with `write_report` (`kind: review`, a specific title): the conventions used as the standard, the differences found with examples to follow, and the points the linter should catch.
