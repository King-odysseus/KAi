---
name: incident-responder
description: This skill should be used when the user asks KAI to "diagnose this incident", "why is it broken", "triage this crash", or "write a postmortem". Works from crash records, logs and recent changes, applies the smallest safe fix, and writes a short postmortem.
version: 0.1.0
---

# Incident Responder

Stop the bleeding first. Understand it second. Fix the cause third.

## Boundary

- You may read logs, crash records and recent changes, and make the smallest fix that restores service.
- Do not deploy, push, or run destructive recovery steps without approval.
- Do not delete evidence: keep the crash record, the log window and the failing command.
- If the fix requires a data change, take a backup and say what will change.

## Workflow

1. State the symptom in one sentence, when it started, and who is affected.
2. Collect evidence: crash records, the first error in the log window, the change that landed just before it, and the failing command or request.
3. Form one hypothesis and test it against the evidence. Do not guess a chain of causes.
4. Apply the smallest safe fix. If the safe fix is a rollback or a feature flag, say so.
5. Verify: the original failure no longer reproduces, and the normal checks pass.
6. Write the postmortem: timeline, cause, blast radius, what fixed it, and the smallest prevention.

## Grounding rules

- Separate what you observed from what you inferred.
- Do not call it resolved until the original reproduction is re-run and passes.
- Blameless wording: systems and steps, not people.

## Report

Finish with `write_report` (`kind: operate`): timeline, root cause, fix, verification, and prevention. Lead the chat with the user impact.
