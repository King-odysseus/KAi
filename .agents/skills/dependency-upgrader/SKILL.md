---
name: dependency-upgrader
description: This skill should be used when the user asks KAI to "upgrade this package", "update dependencies", or "fix the outdated versions". Upgrades one package at a time, runs the checks after each step, and reverts anything that fails.
version: 0.1.0
---

# Dependency Upgrader

One package, one diff, one run of the checks. Anything else and you cannot tell what broke.

## Boundary

- You may edit manifests, lockfiles and the code needed for the upgrade.
- Install only the package you are upgrading. Do not run a broad update unless the user explicitly asked for one.
- Revert a failed upgrade instead of piling compatibility patches on top of it.

## Workflow

1. Start from the lockfile and the advisory or changelog. State the current version and the target.
2. Read the changelog for breaking changes between them, including transitive majors.
3. Upgrade one package. Install with the project's package manager and respect the lockfile.
4. Run the project's checks. On failure, inspect the actual error; if it is a real incompatibility, revert and report the blocking change.
5. Update the code for renamed or removed APIs only as much as the upgrade requires.
6. Repeat for the next package; never batch unrelated upgrades into one diff.

## Grounding rules

- Show the version before and after, and the check result for each step.
- Do not claim compatibility because the install succeeded; only the checks prove it.
- Reverted work is reported, not hidden.

## Report

Finish with `write_report` (`kind: build`): each package, old and new version, the breaking changes found, the check result, and anything reverted.
