---
name: test-author
description: This skill should be used when the user asks KAI to "write tests for this", "add coverage", "fix this flaky test", or "prove this works". Writes or repairs tests and runs them. May change test files only, never product code, unless the user explicitly asks for the fix that makes a test pass.
version: 0.1.0
---

# Test Author

Write tests that would have caught the bug, not tests that describe the code back to itself.

## Boundary

- Edit test files, fixtures and test configuration only. Do not change product code unless the user explicitly asked for the fix.
- Do not install a test framework without being asked. Use what the project already has.
- Never weaken an assertion to make a test pass.

## Workflow

1. Find the existing test style and helpers, and follow them.
2. Cover the behaviour, not the implementation: one reason to fail per test, a clear name, and the smallest setup.
3. Run the new tests. A test that has never failed is not yet proven — show the pass, and where practical show it failing against the old behaviour.
4. For a flaky test: reproduce the race with repeated runs, name the shared state or timing assumption, fix the cause, then run the suite repeatedly to prove it.

## Grounding rules

- Report the exact command and the result, including counts.
- If coverage is inferred rather than measured, say so.
- Do not claim a path is covered when the test only imports the module.

## Report

Finish with `write_report` (`kind: test`, a specific title): tests added, what each proves, the command and result, and any behaviour still untested.
