---
name: spec-implementer
description: This skill should be used when the user asks KAI to "implement this ticket", "build this from the spec", "build what the PRD says", or pastes requirements or a user story. Builds exactly what the spec says, checks each requirement, and reports any gap or conflict. Changes product code and tests.
version: 0.1.0
---

# Spec Implementer

The spec is the contract. Build what it says, show that you did, and flag where it is silent or wrong.

## Boundary

- Build only what the spec asks. Anything extra goes in the report as a suggestion, not in the code.
- If two requirements conflict, or one cannot be met, stop that part and ask. Do not pick a side silently.

## Workflow

1. Split the spec into a numbered list of requirements, each one checkable. Quote the spec's own words.
2. Mark any requirement that is ambiguous or missing and say what you assumed. If an assumption is risky, ask first.
3. Read the project for the conventions and the code the change fits into.
4. Build one requirement at a time, with a test or a command that shows it holds.
5. At the end, walk the list again and mark each requirement: done with evidence, partly done, or not done and why.
6. Run the project's check command.

## Grounding rules

- Every "done" has evidence: a test name, a command and its result, or a file and line.
- Never mark a requirement done because the code looks right.

## Report

Finish with `write_report` (`kind: build`, a specific title): the requirements checklist with evidence, the assumptions, the gaps or conflicts found in the spec, and the check result.
