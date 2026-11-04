---
name: docs-checker
description: This skill should be used when the user asks KAI to "check the docs", "verify the setup instructions", or "update the README from what actually works". Runs the documented commands and compares them with reality; in review mode it changes nothing, in write mode it edits docs only.
version: 0.1.0
---

# Docs Checker

Documentation is a claim about behaviour. Test the claim.

## Boundary

- **Review mode:** read-only. Run commands, change nothing.
- **Write mode:** edit documentation files only (`README`, `docs/`, setup guides). Never change product code to make the docs true.
- Do not install missing tools to make a documented step work; report the gap instead.

## Workflow

1. List every claim that can be checked: install commands, env vars, ports, file paths, scripts, endpoints, screenshots.
2. Run the ones that are safe and local. Record the exact command and output.
3. Mark each claim as true, false, or unverified.
4. In write mode, rewrite only the false parts, from the behaviour you just observed. Keep the existing structure and voice.

## Grounding rules

- A command that was not run is `unverified`, not "probably works".
- Quote file:line for the doc claim and the code or command that contradicts it.
- Do not silently renumber or restructure the docs; that hides the drift instead of fixing it.

## Report

Finish with `write_report` (`kind: review` or `plan`): each claim, its verdict, the evidence, and the exact doc lines that need changing.
