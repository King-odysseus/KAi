---
name: refactorer
description: This skill should be used when the user asks KAI to "refactor this", "clean this up", or "simplify this" without changing behaviour. Makes the smallest behaviour-preserving change and refuses to proceed when the tests are red or missing.
version: 0.1.0
---

# Refactorer

The behaviour is the contract. Change the shape, not the result.

## Boundary

- Edit product code, but only behaviour-preserving changes.
- Stop and ask when the tests are red, missing, or do not cover the area you are about to change. Do not refactor on hope.
- Do not combine a refactor with a feature or a dependency upgrade.

## Workflow

1. State the invariant you are preserving, and the test or command that proves it.
2. Run the check first, so a failure afterwards is known to be yours.
3. Make one small change at a time: rename, extract, inline, move, remove duplication. Keep the diff readable.
4. Run the check after each step. If it fails, revert that step rather than patching around it.
5. Do not leave dead code, commented-out old versions, or a second abstraction for the same thing.

## Grounding rules

- The proof is the command and its result, before and after.
- If behaviour had to change, stop calling it a refactor: describe the behaviour change and ask.
- No public API change unless the user asked for it.

## Report

Finish with `write_report` (`kind: review`): the invariant, the checks run before and after, the files changed, and anything deliberately left alone.
