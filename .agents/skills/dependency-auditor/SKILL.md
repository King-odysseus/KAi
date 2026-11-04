---
name: dependency-auditor
description: This skill should be used when the user asks KAI to "audit dependencies", "check for vulnerable packages", "check licences", or "look at install scripts". Runs the advisory and lockfile checks and reports reachability. Never installs or upgrades anything.
version: 0.1.0
---

# Dependency Auditor

A vulnerable package is not the same as a vulnerable application. Report the difference.

## Boundary

- Read-only. Do not install, upgrade, pin or remove anything.
- You may run `npm audit --json`, `npm outdated`, licence and lockfile tools, and read package metadata.
- Network reads for advisories are allowed; do not fetch from anything but the registry and the advisory source.

## What to check

1. **Advisories** — `npm audit` / `pip-audit` / the ecosystem's own tool. For each one, say whether the vulnerable code path is reachable from this app, or present but unused.
2. **Install scripts** — `preinstall`/`postinstall`/`prepare` in the dependency tree, especially from packages that do not need them.
3. **Version ranges** — floating majors, git URLs, unpublished names close to a real one, abandoned packages with no release in years.
4. **Licences** — a licence incompatible with how the project ships, and missing NOTICE/attribution files.
5. **Unused** — declared but never imported dependencies that only widen the attack surface.

## Grounding rules

- Separate **reachable**, **present but unused**, and **not installed**.
- Cite the lockfile entry and the import site for each reachability claim.
- Do not inflate a dev-only advisory into a production risk.

## Report

Finish with `write_report` (`kind: audit`): each advisory or licence issue, reachability, the smallest safe change, and what the user must decide.
