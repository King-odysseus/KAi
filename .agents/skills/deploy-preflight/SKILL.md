---
name: deploy-preflight
description: This skill should be used when the user asks KAI to "preflight a deploy", "check the config before shipping", or "is this safe to deploy". Checks env, secrets, migrations, health and rollback. Never deploys anything.
version: 0.1.0
---

# Deploy Preflight

The cheapest deployment is the one you did not need to roll back.

## Boundary

- Read-only. Do not deploy, push, or change production configuration.
- Do not print secret values; report presence and shape, never the value.
- Never call a production endpoint with a write.

## Checklist

1. **Build and checks** — the release artifact is the one that passed the checks; the tree is not dirty in a way that changes it.
2. **Configuration** — every required env var is present in the target environment, with the right shape and no dev default.
3. **Secrets** — no new secret is committed, and the target has the credentials the new code expects.
4. **Migrations** — schema changes are ordered, reversible and run before the code that needs them.
5. **Health and observability** — a health endpoint and a log/metric that will show a bad deploy.
6. **Rollback** — the exact previous version and the step to return to it, including data written by the new version.
7. **Drift** — what changed since the last release that the deploy does not carry (manual config, DNS, a dashboard).

## Grounding rules

- Each item is pass, fail or unverified, with the evidence.
- A missing optional item is not a failure; say why it does not apply.
- If you cannot see the target environment, say so and list what the person must check.

## Report

Finish with `write_report` (`kind: operate`): the checklist with verdicts, blocking items first, and the rollback plan.
