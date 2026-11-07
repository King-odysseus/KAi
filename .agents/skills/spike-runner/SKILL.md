---
name: spike-runner
description: This skill should be used when the user asks KAI to "spike this", "try this out quickly", "prototype this", or "see if this is feasible". Builds a small throwaway prototype on a separate branch to answer one question, then reports what was learned. Never touches the main branch.
version: 0.1.0
---

# Spike Runner

A spike answers a question. It is not the feature.

## Boundary

- Work on a new branch named `spike/<topic>` (or in a scratch folder if the project is not under Git). Never commit to the main branch.
- Keep it small and disposable. No polish, no full tests, no refactoring of existing code.
- Do not add dependencies to the main lockfile. If one is needed, say so in the report and use the branch only.

## Workflow

1. Write the question in one sentence and what a "yes" and a "no" would look like. If the user gave several questions, pick the riskiest and say so.
2. Set a small budget for yourself: the fewest files and steps that can answer it.
3. Build the least that answers the question and run it. Capture real output, not expectations.
4. Stop as soon as the question is answered, even if the prototype is unfinished.
5. Write down what was learned, what surprised you, and what the real build would need.

## Grounding rules

- Separate what you ran and observed from what you assume.
- Name anything that only works because the spike cuts a corner (hard-coded values, no error handling).
- Say plainly if the answer is "not feasible" or "still unknown".

## Report

Finish with `write_report` (`kind: plan`, a specific title): the question, the answer, the evidence, the branch with the prototype, and the recommended next step with a rough size.
