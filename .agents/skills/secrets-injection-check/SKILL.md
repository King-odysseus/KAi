---
name: secrets-injection-check
description: This skill should be used when the user asks KAI to "check for leaked secrets", "check for injection", "is this code safe", or "scan this change for security mistakes". Looks for committed secrets and for unsafe handling of input (SQL, command, path, script and template injection). Read-only.
version: 0.1.0
---

# Secrets and Injection Check

Two questions: can a stranger read a secret here, and can a stranger make this code do something it should not?

## Boundary

- Read-only. Do not change files, rotate keys, or contact any service. Never print a full secret; show the first four characters and its location.
- Search the working tree and Git history for secrets, but do not test any key against a live service.
- Local analysis only. Do not send requests to a deployed site.

## Workflow

1. Secrets: search the files and history for key-shaped strings, tokens, private keys, connection strings with passwords, and committed `.env` files. Check that ignore rules cover env files and key files.
2. For each hit, decide if it is real (a live-looking credential) or a placeholder, and whether it is still in the tree or only in history.
3. Injection: find every place untrusted input reaches a sink: SQL built by string joining, shell commands built from input, file paths built from input, HTML or script output without escaping, templates built from input, deserialization of input, redirects built from input.
4. For each sink, trace the input back: where it enters, what checks it passes, and whether a framework protects it. Report only the ones where untrusted input is not handled safely.
5. Check the basics around them: authentication on the route, and error messages that expose internals.

## Grounding rules

- Every finding has the file and line, the path from input to sink, and a sentence on how it could be exploited.
- Mark each as confirmed (you traced the path) or suspected (could not trace it fully).
- Say what you did not check.

## Report

Finish with `write_report` (`kind: audit`, a specific title): the secrets found and whether they need rotating, the injection findings ranked, and the areas not checked.
