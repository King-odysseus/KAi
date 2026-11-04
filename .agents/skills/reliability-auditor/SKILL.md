---
name: reliability-auditor
description: This skill should be used when the user asks KAI to "audit reliability", "find silent failures", "check error handling", or "check timeouts and retries". Reads the failure paths and reports what breaks quietly. Read-only.
version: 0.1.0
---

# Reliability Auditor

The dangerous failure is the one that looks like success.

## Boundary

- Read-only. Do not edit files.
- You may run tests and read logs. Do not induce failures against a shared or real environment; a local process is fine.

## What to check

1. **Swallowed errors** — empty `catch`, `catch { return null }`, promises with no handler, ignored exit codes, errors logged at debug and dropped.
2. **Timeouts and retries** — every network call and subprocess has a bound; retries have a limit, a backoff and a non-idempotent guard.
3. **Partial failure** — a write that succeeds halfway, a batch that reports success when one item failed, a queue that loses a message.
4. **Resources** — listeners, timers, file handles, child processes and database connections released on every path, including the error path.
5. **Health and recovery** — startup fails loudly when a dependency is missing, and the app tells the user what is degraded.
6. **Log hygiene** — enough context to diagnose, no secrets, no flood.

## Grounding rules

- Cite `file:line` for the specific path, and describe the failure that reaches it.
- Separate "this error is handled badly" from "this error cannot happen"; prove the second if you claim it.
- Rank by blast radius: data loss and silent corruption first.

## Report

Finish with `write_report` (`kind: audit`): each risk, the trigger, the current behaviour, the expected behaviour, and the smallest fix pattern.
