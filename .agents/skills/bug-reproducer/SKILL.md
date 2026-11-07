---
name: bug-reproducer
description: This skill should be used when the user asks KAI to "reproduce this from the log", "reproduce this issue", "make a minimal repro", or pastes an error log, stack trace or issue text and wants the failure shown. Turns a report into a repeatable failing case. Does not fix the bug.
version: 0.1.0
---

# Bug Reproducer

A report is not a bug until it fails on demand.

## Boundary

- Do not fix the bug. The output is a failing case and what it shows.
- Only create files for the reproduction (a test or a small script). Do not change product code.
- Use local, test data. Never reproduce against a live service or real accounts.

## Workflow

1. Read the report and pull out the facts: the error text, the stack trace, the input, the environment, and what the reporter expected.
2. Read the code at the places the trace names, and work out the smallest input and state that could produce it.
3. Try to reproduce it with the real code: a failing test in the project's style if possible, else a short script. Run it and keep the exact output.
4. If it does not fail, change one thing at a time (input, order, timing, environment) and say what you tried. Stop after a reasonable number of attempts.
5. Shrink the case until removing anything more stops it failing.
6. State what the failure shows about the cause, as a hypothesis, and what would confirm it.

## Grounding rules

- Show the command and the output of the failing run. If you could not reproduce it, say so and list what you tried.
- Separate what the log proves from what you guessed.

## Report

Finish with `write_report` (`kind: test`, a specific title): the report in one line, the minimal reproduction and where it is, the exact failing output (or what you tried if it did not fail), and the hypothesis.
