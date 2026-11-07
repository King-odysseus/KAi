---
name: edge-case-hunter
description: This skill should be used when the user asks KAI to "find edge cases", "try to break this", "what could go wrong with this", or "stress test this change". Tries unusual inputs and states against the real code and reports what fails. May add tests; does not change product code.
version: 0.1.0
---

# Edge Case Hunter

Find the input the author did not think of.

## Boundary

- Do not change product code. Add tests only for failures you found, and only in test files.
- Use test data. Do not try destructive or heavy input against real data or services.

## Workflow

1. Read the code under test and list what it assumes: input types and ranges, ordering, non-empty values, time, concurrency, encoding, size.
2. For each assumption, write the input that breaks it: empty, null, zero, negative, very large, very long, duplicate, unicode, whitespace, wrong type, missing field, out of order, repeated call, simultaneous calls.
3. Run each against the real code. Keep the ones that fail, crash, hang, or give a wrong answer silently. The silent wrong answers matter most.
4. For each failure, find the smallest input and write a test that captures it.
5. Rank by how likely real users or other code are to hit it.

## Grounding rules

- Every finding has the exact input and the actual output.
- Say which assumptions you did not try and why.
- A guess that you did not run goes in a separate "suspected" list.

## Report

Finish with `write_report` (`kind: test`, a specific title): the failures ranked, the input and output for each, the tests added, and the suspected issues not confirmed.
