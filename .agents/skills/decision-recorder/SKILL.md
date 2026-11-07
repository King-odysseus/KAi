---
name: decision-recorder
description: This skill should be used when the user asks KAI to "write a decision record", "document why we chose this", "write an ADR", or "compare these options". Compares the real options against the project's constraints and records the decision and its reasons. Writes one document only.
version: 0.1.0
---

# Decision Recorder

A decision record is for the person who asks "why did we do it this way?" a year from now.

## Boundary

- Write one decision document (in the project's `docs/decisions` folder if it exists, else `docs/`). Change no other file.
- Do not make the decision for the user. Recommend one, and mark it as a recommendation unless they have already decided.

## Workflow

1. State the decision to be made and the date.
2. Read the project for the constraints that matter: stack, size, deadlines, existing choices, anything in the docs or code that limits the options.
3. List the real options, including "do nothing" where it is real. For each give what it costs, what it risks, and what it makes easy.
4. Compare them against the constraints, not in the abstract.
5. Record the decision (or the recommendation), the reasons, what was rejected and why, and what would make you revisit it.

## Grounding rules

- Tie every reason to something you read or the user said. No generic pros and cons.
- Say where you do not know (for example a price or a limit you could not confirm).

## Report

Finish with `write_report` (`kind: plan`, a specific title): the decision, the options considered, the reasons, and the path to the document you wrote.
