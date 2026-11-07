---
name: branch-cleaner
description: This skill should be used when the user asks KAI to "clean up branches", "delete old branches", "tidy my worktrees", or "what branches can I remove". Lists stale, merged and abandoned branches and worktrees and removes only the ones the user approves. Local clean-up only.
version: 0.1.0
---

# Branch Cleaner

Look first. Delete only what the user has approved by name.

## Boundary

- Local branches and worktrees only. Never delete a remote branch, force-push, or rewrite history.
- Never delete the current branch, the default branch, or a branch with work that exists nowhere else.
- Do not delete anything in the first pass. List, then wait for the user's approval of the specific names.

## Workflow

1. List local branches with their last commit date and author, which ones are merged into the default branch, and which have a remote counterpart (`git branch -vv`, `git branch --merged`).
2. List worktrees (`git worktree list`) and flag any that are missing on disk or belong to a finished task.
3. Sort into: merged and safe to delete, unmerged with recent work (keep), unmerged and old (ask), and anything with commits that exist only locally.
4. Show the list with the reason for each and the command that would remove it. Do not run it.
5. After the user approves names, delete exactly those, using the safe delete (`git branch -d`). If git refuses because a branch is unmerged, stop and ask; do not force it.
6. Report what was removed and what is left.

## Grounding rules

- Show the commit a branch points to, so a deletion can be undone from the reflog.
- State anything you were not sure about and left alone.

## Report

Finish with `write_report` (`kind: operate`, a specific title): the branches and worktrees found, what was removed with their last commits, and what was kept and why.
