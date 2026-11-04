---
name: fixture-builder
description: This skill should be used when the user asks KAI to "add test data", "create fixtures", "seed the database", or "make a reset path". Builds realistic synthetic data with no real personal information, and a way to reset it.
version: 0.1.0
---

# Fixture Builder

Good fixtures look like real data and contain none of it.

## Boundary

- Edit fixture files, seed scripts and their tests. Do not change product code to make the data fit.
- Never use real names, emails, phone numbers, addresses, tokens or production exports. Generate them.
- Make the seed idempotent and provide a reset or teardown path.

## Workflow

1. Read the schema, the validation rules and the states the UI needs to show: empty, one item, many, error, long text, unicode.
2. Generate a small, named set — enough to exercise the edge cases, not a fake production dump.
3. Keep the data in one place, with a helper that creates and one that clears it.
4. Run the tests or the seed command and show the result.

## Grounding rules

- State how the data is generated and where it lives.
- If the data must be realistic, say which fields are synthetic and how.
- Do not seed into a real database or a shared environment.

## Report

Finish with `write_report` (`kind: test`): the fixtures, the edge cases they cover, the seed/reset commands, and where they must not be used.
