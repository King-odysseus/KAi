---
name: security-auditor
description: This skill should be used when the user asks KAI to "attack my app and find vulnerabilities", "red-team my code", "try to hack my own app", "run a security audit and file fixes", or "stress-test my app for security bugs before I ship it". Covers a local-only static + dynamic vulnerability sweep of the project the user is building, with findings filed as fixer tasks and as concept cards for the Learn tab. Never targets anything but the project's own code and its own dev server on localhost.
version: 0.1.0
---

# Security Auditor

An adversarial reviewer for the user's own app: it tries to break the app the way an attacker would, then hands off
what it found. It is not a pentest-as-a-service tool and it does not touch anyone else's systems.

## Hard boundary: local only

- The only valid target is this project's own source tree and, for the dynamic pass, a dev server the auditor
  itself starts on `localhost`/`127.0.0.1`. Never a deployed URL, never a Railway/production hostname, never
  anything the user did not start locally in this session.
- Before any dynamic probe, confirm the target host is `localhost` or `127.0.0.1`. If a step would need a
  non-local host — a staging URL, a Railway deployment, anything with a real hostname — stop and tell the user
  this skill only covers local targets; do not proceed, even if asked to "just this once."
- No rate-limit evasion, no credential stuffing against anything but a local test account the user owns, no
  destructive payloads (no data-deleting SQL, no `rm`-style traversal writes). The goal is to prove a vulnerability
  exists with the smallest safe payload, not to maximize damage.

## Attack flow

1. **Static pass.** Run `/security-review` (or an equivalent full-repo review) focused on: injection (SQL, command,
   template), auth/session handling, secrets committed to the repo, insecure deserialization, path traversal, SSRF,
   dependency CVEs (`npm audit` / lockfile check), CORS and security-header misconfiguration, and unsafe use of
   `eval`/`Function`/child-process calls built from user input.
2. **Dynamic pass (local only).** Start the project's dev server (via the `run` skill or the project's own start
   script). Use Playwright MCP, pointed only at the `localhost` URL just started, to:
   - Try payload variants (`' OR 1=1`, `<script>`, `../../etc/passwd`, oversized/garbage input, mismatched
     content-types) against the app's own forms and local API routes.
   - Try session/auth tampering against a local test account created for this purpose — never a real account,
     never anything with live credentials.
   - Record exactly what request/input triggered what response; a finding is only real once it's reproduced.
3. **For every reproduced finding, write a finding record** (see `references/finding-template.md`) with:
   severity, vuln class, file/location, the exact reproduction steps, and a short concept card — what the bug
   class is, why it's exploitable, and the fix pattern — written for someone learning the concept, not just fixing
   the line.
4. **File a fixer task** for each finding through the project's existing task system (`task_create`/`task_route`),
   so it's routed to whichever agent the project already assigns that kind of work to. Do not fix the
   vulnerability directly in this pass unless the user asks for that — the point is to separate "found it" from
   "fixed it" so both get reviewed.
5. **Log the finding** to the project's security findings store (`SecurityFindingsStore` / `@kai/contracts`
   `security-findings`) so it surfaces on the Learn tab as a concept card, independent of the fixer task's status.

## Reporting

End with a short summary table: severity, vuln class, location, task filed (yes/id). Don't bury a critical finding
in prose — lead with it. If nothing was found, say that plainly rather than padding the report with info-level
nitpicks to look thorough.
