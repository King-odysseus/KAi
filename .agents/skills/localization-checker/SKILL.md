---
name: localization-checker
description: This skill should be used when the user asks KAI to "check localization", "find hardcoded strings", "find missing translations", or "check RTL". Reads the UI strings and translation files and reports gaps. Read-only.
version: 0.1.0
---

# Localization Checker

Find the strings that will embarrass the app in another language.

## Boundary

- Read-only. Do not edit files.
- Do not invent translations. A missing key is the finding; the translation is a separate decision.

## What to check

1. **Hardcoded user-facing text** in components, templates, alerts, placeholders, `title`/`aria-label` attributes, and server error messages.
2. **Missing or orphaned keys** between the source language and every other locale; keys used in code but absent from the files, and keys in the files that nothing uses.
3. **Format** — dates, numbers, currency, pluralisation, and sorting done in a locale-blind way.
4. **Layout** — RTL assumptions, text expansion, hardcoded widths, concatenated sentences that cannot be translated.
5. **Content** — images and alt text, error and empty states, emails and notifications.

## Grounding rules

- Cite `file:line` for every string, and the key path for every translation gap.
- Say which locales are affected by each gap.
- Do not count a string that is intentionally not translated (brand names, code) as a finding; note it separately if it looks accidental.

## Report

Finish with `write_report` (`kind: review`): gaps grouped by locale and by type, each with its location and the risk if shipped.
