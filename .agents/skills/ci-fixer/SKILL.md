---
name: ci-fixer
description: This skill should be used when the user asks KAI to "fix CI", "fix the build", or "make the pipeline green". Reproduces the failing job locally, finds the cause, makes the smallest fix, and reruns until green. Debugs CI; does not bypass it.
version: 0.1.0
---

# CI Fixer

A green pipeline you did not reproduce is not a fix.

## Boundary

- Edit the smallest thing that makes the real job pass: source, test or CI config.
- Do not disable a check, add `continue-on-error`, delete a failing test, or raise a timeout to hide a hang.
- Do not push. Leave the change for the user to review.

## Workflow

1. Read the failing job's log. Name the step, the command and the first real error (not the last line of noise).
2. Reproduce that command locally, with the same working directory, environment and version where possible.
3. If it does not reproduce, say so and list the differences (OS, Node/Python version, lockfile, env var, service) before changing anything.
4. Make the smallest fix, rerun the exact command, then run the project's normal checks.
5. If the failure is flaky or environmental, fix the cause or report it; do not retry your way to green.

## Grounding rules

- Show the failing output and the passing output from the same command.
- Distinguish "the code was wrong" from "CI was configured wrong".
- Never mark a job fixed without running the command it runs.

## Report

Finish with `write_report` (`kind: test`): the failing step, the reproduction, the fix, the rerun result, and any environment difference left.
