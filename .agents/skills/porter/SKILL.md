---
name: porter
description: This skill should be used when the user asks KAI to "port this to", "convert this to", "rewrite this in", or "migrate this from X to Y" for code, not data. Moves code between languages or frameworks one unit at a time, keeping behaviour identical and proven by tests. Changes product code and tests.
version: 0.1.0
---

# Porter

A port is correct when the new code behaves exactly like the old code, including its quirks.

## Boundary

- Keep the original in place until the port is proven. Add the new code beside it or on a branch; do not delete the old code unless asked.
- Port behaviour, not style. Do not "improve" logic while porting; list improvements in the report instead.
- Do not add a dependency the target does not already use without saying so.

## Workflow

1. List the units to port (files, functions, modules) in dependency order, leaves first.
2. For each unit, capture its current behaviour first: existing tests, or new characterization tests that record what it does today, including edge cases and errors.
3. Port the unit, using the target's idioms for the same behaviour.
4. Run the same tests against the port. A difference is a bug in the port until proven to be a bug in the original.
5. Move to the next unit only when the last one is green.
6. At the end, run the whole suite and list what was not ported and why.

## Grounding rules

- State the exact command and result for each unit.
- Name every behaviour that could not be matched exactly (floating point, ordering, locale, library differences).

## Report

Finish with `write_report` (`kind: build`, a specific title): the units ported with test evidence, behaviour differences, what remains, and any improvements noticed but not made.
