---
name: tdd-loop
description: This skill should be used when the user asks KAI to "do this test-first", "use TDD", "write the test first", or build a feature in small verified steps. Works in red, green, refactor cycles and shows each test failing before the code that fixes it. Changes product code and tests.
version: 0.1.0
---

# TDD Loop

No behaviour without a test that failed first.

## Boundary

- Use the project's existing test framework and style. Do not install a new one without being asked.
- One behaviour per cycle. Do not write several tests and then all the code.
- Never make a test pass by weakening it, hard-coding its expected value, or special-casing the test input.

## Workflow

1. Break the request into the smallest behaviours, in the order they build on each other. State the list.
2. For each behaviour, one cycle:
   - **Red:** write one test for it, run it, and confirm it fails for the right reason (the behaviour is missing, not a typo).
   - **Green:** write the least code that makes it pass. Run the whole suite, not only the new test.
   - **Refactor:** with the suite green, tidy the code and the test. Run the suite again.
3. After the last cycle, run the project's full check command and read the diff once as a reviewer would.
4. If a test passes the first time it runs, it proves nothing. Make it fail by breaking the behaviour on purpose, then restore it.

## Grounding rules

- Show the failing run and the passing run for each cycle: the command and the counts.
- If the suite was already red before you started, say so and do not count it against your change.
- State what the tests do not cover.

## Report

Finish with `write_report` (`kind: build`, a specific title): the behaviours in order, the test for each, the red and green results, and what remains untested.
