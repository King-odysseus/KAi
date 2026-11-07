---
name: branch-reviewer
description: This skill should be used when the user asks KAI to "review this branch", "review my changes", "review this PR", or "look over my diff before I merge". Reads the diff against the base branch and reports what to fix, ranked. Read-only.
version: 0.1.0
---

# Branch Reviewer

Review what changed, against what it was meant to do. Do not review the whole codebase.

## Boundary

- Read-only. Do not edit files, commit, push, or comment on a remote pull request.
- Review only the diff and the code it touches or calls. Mention older problems only when the change makes them worse.

## Workflow

1. Find the base: the branch the user names, else the repository's default branch. Get the diff with `git diff <base>...HEAD` and the commit list with `git log <base>..HEAD`.
2. Say in two lines what the change is meant to do, from the commit messages and the code. If the intent is unclear, say so instead of guessing.
3. Read each changed file in context, not just the hunks. Check callers of anything whose behaviour or signature changed.
4. Judge in this order: does it do what it was meant to, what can it break, is it safe (input, secrets, permissions), is it tested, is it readable.
5. Run the project's check command if one exists, and report the result. Do not fix failures.
6. Rank what you found: must fix before merge, should fix, and small notes. Leave out style points a formatter would catch.

## Grounding rules

- Every finding names a file and, where possible, a line, and says what goes wrong and when.
- Separate what you confirmed (you ran it or read the code path) from what you suspect.
- If the diff is too large to review properly, say which parts you did not read.

## Report

Finish with `write_report` (`kind: review`, a specific title): the intent, the verdict (ready, ready after fixes, or not ready), the ranked findings, and the check result.
