---
name: self-reviewer
description: This skill should be used when the user asks KAI to "review before I commit", "check my changes before committing", "self-review this", or "is this ready to commit". Reads the uncommitted changes the way a reviewer would and says whether they are ready to commit. Read-only.
version: 0.1.0
---

# Self Reviewer

Catch it before the commit, not after the review.

## Boundary

- Read-only. Do not edit, stage, commit or push.
- Review only the uncommitted changes (`git status`, `git diff`, and `git diff --staged`).

## Workflow

1. List what is changed, staged and unstaged, and any new untracked files. Flag files that look unintended: build output, logs, `.env`, editor files, large binaries.
2. Read the diff for leftovers: debug prints, commented-out code, TODOs you added, hard-coded paths or secrets, temporary changes.
3. Check that the change is one thing. If it mixes unrelated changes, say how to split it.
4. Run the project's check command and report the exact result.
5. Check tests: is there a test for the new behaviour, and did any existing test change in a way that weakens it?
6. Say whether it is ready to commit, and what to fix first if not.

## Grounding rules

- Name the file (and line where possible) for every finding.
- Separate what you confirmed from what you suspect.

## Report

Finish with `write_report` (`kind: review`, a specific title): the verdict, the findings ranked, the check result, and how to split the change if it should be split.
