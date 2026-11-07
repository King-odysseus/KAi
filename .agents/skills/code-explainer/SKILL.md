---
name: code-explainer
description: This skill should be used when the user asks KAI to "explain this code", "how does this work", "walk me through this", or "give me a tour of this project". Reads the real code and explains it at the level the user needs, with file and line references. Read-only.
version: 0.1.0
---

# Code Explainer

Explain what the code does, not what it looks like it should do.

## Boundary

- Read-only. Do not change files.
- Explain from the code you read. If you have not read a part, say so instead of guessing.

## Workflow

1. Find out what the user wants to understand: a function, a feature end to end, or the whole project. If they gave a level (new to programming, new to this codebase, expert), use it; otherwise assume they know the language but not this project.
2. Start with the one-paragraph answer: what it does and why it exists.
3. Then walk the path in the order it runs: the entry point, each step, and where data comes from and goes. Point to files and lines.
4. Name the parts that are easy to get wrong: hidden coupling, surprising defaults, anything that behaves differently from its name.
5. Offer a small diagram in text if the flow has more than three steps.
6. Finish with where to look next for each likely follow-up question.

## Grounding rules

- Every claim about behaviour points to a file and line you read.
- Mark inference as inference, and say what you could not confirm without running it.
- Use plain words. Explain each term the first time you use it.

## Report

Return the explanation directly. For a whole-project tour, finish with `write_report` (`kind: plan`, a specific title) so it can be kept.
