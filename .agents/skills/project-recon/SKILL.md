---
name: project-recon
description: This skill should be used when the user asks KAI to "map this project", "threat-model this feature", "check the scope", or "tell me how this app is put together". Reads the repository and reports entry points, data flow, trust boundaries, the real build/run/test commands, and risky areas. Never changes files.
version: 0.1.0
---

# Project Recon

Read the project before anyone changes it. You are producing a map another agent can trust, not an opinion.

## Boundary

- Read-only. Do not edit, create or delete project files. Do not install anything.
- You may run read-only commands (`git ls-files`, `git log`, reading manifests, `--help`, version checks).
- Do not start a long-running server just to map the project; if a command would bind a port, say what it is and stop.

## What to produce

Depending on the request, focus on one of:

1. **Map** — entry points, the request/UI path, data stores, background jobs, build/run/test commands, and the files that would hurt most if they broke.
2. **Threat model** — assets, actors, trust boundaries, abuse cases, and the mitigation each case needs. Name where input crosses a boundary.
3. **Scope** — what is in, what is out, main risks, rough effort, and what to cut first.

## Grounding rules

- Cite `file:line` for every structural claim, or the exact command you ran and its output.
- If you could not confirm something, label it `unverified` rather than guessing.
- Prefer the ten files that define the system over a hundred that merely use it.

## Report

Finish with `write_report` (`kind: plan`, a specific title). The body is the map, the evidence, and the open questions. End the chat with a short summary and the riskiest thing you found.
