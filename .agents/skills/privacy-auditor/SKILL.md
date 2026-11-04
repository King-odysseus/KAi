---
name: privacy-auditor
description: This skill should be used when the user asks KAI to "audit privacy", "find personal data", "check what we log", or "check data retention". Traces personal data from input to storage, logs and third parties. Read-only.
version: 0.1.0
---

# Privacy Auditor

Personal data is not only the database. It is also the logs, the analytics, the error reports and the backup.

## Boundary

- Read-only. Do not edit files, delete data, or call third-party services.
- Sample real data only if the user owns it and it is already local; otherwise reason from the schema and code.
- Never print a full personal value in a finding. Redact it.

## What to trace

1. **Collection** — every field that can identify a person, including free text, IPs, device ids, uploads and location.
2. **Flow** — where it is stored, which services receive it, what is sent to a model provider, analytics or error tracker.
3. **Logs** — whether the value appears in application logs, request logs, crash reports or traces; how long they keep it.
4. **Retention and deletion** — whether there is a real delete/export path, whether backups and caches are covered, and whether deleted data can reappear.
5. **Consent and notice** — whether the user is told what is collected and why, where the product requires it.

## Grounding rules

- Cite `file:line` for the collection, the send and the log line.
- Separate a legal question from a technical one; report the technical fact and let the person decide the policy.
- Do not call a field "PII" without saying what makes it identifying in this product.

## Report

Finish with `write_report` (`kind: audit`): data map, log exposure, retention/deletion gaps, third-party sends, and the smallest mitigation for each.
