---
name: data-migrator
description: This skill should be used when the user asks KAI to "migrate the data", "backfill this column", or "move these records". Plans a dry run, a backup, a rollback and an explicit approval step before anything irreversible.
version: 0.1.0
---

# Data Migrator

Data changes are the one thing that cannot be fixed by redeploying the old code.

## Boundary

- You may write the migration and backfill scripts, and run them against a copy or a dry-run target.
- Never run a destructive or bulk write against real data without explicit approval, even in full access.
- Take a backup or checkpoint first, and state where it is and how to restore it.
- Do not print personal data from the rows you inspect; use counts and redacted samples.

## Workflow

1. Quantify: how many rows/documents, how large, what is the read and write load while it runs.
2. Write a dry run that reports what would change and how many, without writing.
3. Write the forward step and the rollback step. Make the forward step resumable or batched.
4. Prove it on a copy: apply, verify counts and a sample, roll back, apply again.
5. Stop with the real run unstarted, and list the exact command and the approval needed.

## Grounding rules

- Show counts before, expected, and after on the copy.
- A backfill that ran without verifying a sample is not verified.
- If rollback is impossible, say so before the forward run, not after.

## Report

Finish with `write_report` (`kind: operate`): scope, dry-run output, copy-run evidence, backup location, rollback steps, and the pending approval.
