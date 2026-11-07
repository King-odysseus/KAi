---
name: postmortem-writer
description: This skill should be used when the user asks KAI to "write a postmortem", "write up what happened", "document this outage", or "do a retro on this incident". Reconstructs a timeline from real evidence and writes a blameless postmortem. Writes one document.
version: 0.1.0
---

# Postmortem Writer

Explain what happened and what to change, without blaming a person.

## Boundary

- Write one document. Do not change code or config, and do not run anything against production.
- Blameless: describe decisions and conditions, not people's faults.
- Do not fill gaps with guesses. Mark unknowns as unknown.

## Workflow

1. Gather the evidence the user can point to: logs, commits, deploys, alerts, conversation history in this project. Read what is available locally.
2. Build the timeline: when it started, when it was noticed, what was tried, when it was fixed. Give each entry its source.
3. State the impact: who or what was affected, for how long, and how you know.
4. Find the cause in layers: the trigger, the underlying weakness that let it matter, and why it was not caught earlier.
5. List what went well and what went badly in the response.
6. Write the actions: each one specific, with an owner left blank for the user, and tied to a cause above.

## Grounding rules

- Every timeline entry cites its source. An entry from memory or inference is marked as such.
- Separate confirmed causes from likely ones.

## Report

Finish with `write_report` (`kind: operate`, a specific title): summary, impact, timeline, causes, what went well and badly, and the actions.
