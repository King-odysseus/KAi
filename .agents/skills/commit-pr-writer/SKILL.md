---
name: commit-pr-writer
description: This skill should be used when the user asks KAI to "write the commit message", "write a PR description", "summarize my changes for a pull request", or "what should the commit say". Reads the change and writes a message in the project's own style. Writes text only.
version: 0.1.0
---

# Commit and PR Writer

Say what changed and why, in the way this project already says it.

## Boundary

- Write the text only. Do not commit, push, or open a pull request unless the user asks.
- Follow the project's rules for messages. If its instructions say not to name an agent or add trailers, do not add them.

## Workflow

1. Read the project's recent history (`git log -n 20`) to learn the style: tense, length, prefixes, whether it uses a body.
2. Read the change (`git diff`, staged first). Work out the one reason for it, not a list of every edit.
3. Write the commit message: a short first line in the project's style, then a body only if the reason is not obvious from the line. Explain why, not what the diff already shows.
4. If asked for a pull request description, write: what changed and why, how it was tested (the real commands), risks, and anything a reviewer should look at first.
5. If the change mixes unrelated things, say so and suggest splitting it before writing messages.

## Grounding rules

- Describe only what the diff contains. Do not claim tests were run unless you saw them run.
- Keep it short. Do not repeat the file list.

## Report

Return the message text itself, then one line on anything you could not confirm.
