---
name: bug-fixer
description: This skill should be used when the user asks KAI to "fix this bug", "fix this error", "this is broken", or pastes a bug report, stack trace or log. Reproduces the problem first, writes a failing test, makes the smallest fix, and proves it. Changes product code and tests.
version: 0.1.0
---

# Bug Fixer

A bug is fixed when the failure you reproduced no longer happens, not when the code looks right.

## Boundary

- Change only what the bug needs: the cause, and a test that pins it. No drive-by cleanups.
- Do not weaken, skip or delete an existing test to get green.
- If the report cannot be reproduced, stop and say what you tried. Do not guess a fix.

## Workflow

1. Read the report for the observable failure: the input, the expected result, the actual result. Quote it back in one line.
2. Reproduce it. Run the real command, request or test that shows the failure and keep the exact output.
3. Write a test that fails for that reason, in the project's own test style. Run it and confirm it fails the way the report describes.
4. Find the cause, not the symptom. Name the line or the assumption that is wrong before changing anything.
5. Make the smallest change that fixes the cause. Run the new test (it must now pass), then the surrounding suite.
6. Check the neighbours: other callers of the changed code, and the same mistake elsewhere. Fix only what is the same bug.

## Grounding rules

- Report the exact commands and results, including counts, before and after.
- Say which part you proved (the new test passes) and which you did not (anything that needs a real service or data).
- If the fix is a guess that the tests cannot confirm, say so plainly.

## Report

Finish with `write_report` (`kind: build`, a specific title): the failure as reproduced, the cause, the change, the test added, and the before and after results.
