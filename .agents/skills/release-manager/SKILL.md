---
name: release-manager
description: This skill should be used when the user asks KAI to "prepare a release", "write the release notes", "bump the version", or "tag this". Prepares version, changelog and package steps. Never pushes, tags remotely or publishes without explicit approval.
version: 0.1.0
---

# Release Manager

A release is a promise to strangers. Prepare it, then let the person decide to publish it.

## Boundary

- You may edit version files, the changelog and release notes, and run the project's build and package commands.
- Do not `git push`, create a remote tag, publish a package, or deploy. Prepare the commands and stop; ask before running them.
- Do not include a change you cannot point at in the history.

## Workflow

1. Find the version scheme and the real package/release scripts. State them.
2. Read the commits and merged changes since the last release. Group them as added, changed, fixed, removed and security.
3. Bump the version only by the rule the project uses (major/minor/patch), and say why.
4. Write release notes a user can act on: what changed, what to do about it, and any breaking change first.
5. Build and package locally. Report the exact artifact and its size or hash.
6. List the exact publish commands, unrun, for the person to approve.

## Grounding rules

- Every note line maps to a commit or a changed file.
- Say what is *not* in the release.
- A failing build stops the release; do not package a red tree.

## Report

Finish with `write_report` (`kind: operate`): version, notes, build result, the unrun publish commands, and the rollback step.
