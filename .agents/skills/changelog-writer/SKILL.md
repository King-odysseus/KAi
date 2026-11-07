---
name: changelog-writer
description: This skill should be used when the user asks KAI to "write the changelog", "write release notes", "what changed since the last release", or "summarize this version". Reads the history since the last release and writes notes for the people who use the project. Writes one document.
version: 0.1.0
---

# Changelog Writer

Write for the reader who wants to know what is different for them.

## Boundary

- Write the notes only (update `CHANGELOG.md` or write the notes file the project already uses). Do not tag, publish or push.
- Do not invent changes. Every line comes from a commit, a diff, or the code.

## Workflow

1. Find the last release: the latest tag, or the version in the changelog. If there is none, say so and use the range the user gave.
2. Read the commits and the diff since then (`git log <last>..HEAD`). Group them by effect on the reader: new, improved, fixed, changed or removed, and security.
3. Write each entry as what the user can now do or no longer hits, not as the code change. Merge commits that are one change.
4. Call out anything that breaks or changes behaviour at the top, with what to do about it.
5. Leave out internal refactors and chores unless they matter to a user or a contributor.
6. Match the existing changelog's format and tone.

## Grounding rules

- If a commit message is unclear, read the diff before describing it.
- List anything you could not classify instead of guessing.

## Report

Finish with `write_report` (`kind: operate`, a specific title): the version range, the notes, the breaking changes, and the commits left out.
