---
name: legal-compliance-checker
description: This skill should be used when the user asks KAI to "check legal compliance", "can I distribute this in <country>", "check data protection laws", "check GDPR", "check app store rules", or "check export rules". Looks up the laws and data regulations of each country the app may be distributed in and compares them with what the app actually does. Read-only.
version: 0.1.0
---

# Legal Compliance Checker

An app is judged by the law where its users are, not where its developer is. This skill finds out where the app will be used, what each place requires, and where the code falls short.

## Boundary

- Read-only. Do not edit files or contact a regulator, store or user.
- This is a technical review, not legal advice. Every report says so and tells the owner which points need a qualified lawyer in that country.
- Laws change. Look each rule up in a current source (the regulator's own site first, then a reputable summary), record the source and the date you read it, and say when you could not confirm something. Never rely on memory alone for a threshold, a fine or a deadline.

## Steps

1. **Scope the markets.** Ask the owner, or read the project (store listings, locale files, currencies, payment providers, hosting regions, docs), which countries or regions the app will be distributed or used in. If none is stated, start from the likely ones and list them as assumptions.
2. **Profile the app.** From the code, record what it does that the law cares about: personal data collected, children as users, payments, health or financial data, location, accounts, user content, AI features, encryption, analytics and ad SDKs, cross-border transfers, and where data is stored.
3. **For each market, look up the rules that apply to that profile.** Typical areas: data protection and privacy (GDPR and UK GDPR, CCPA/CPRA, LGPD, NDPR in Nigeria, POPIA, PIPEDA, PDPA, and others), children's data, consumer and payment rules, e-commerce and tax notices, accessibility law, content and platform liability, AI transparency rules, encryption and export controls, sanctions, local-hosting or data-residency duties, and app store policies. Use only the ones the profile triggers.
4. **Compare with the code.** For each applicable rule, find the evidence: consent and notice screens, privacy policy and terms, delete and export paths, retention, breach handling, age checks, cookie handling, data processing agreements with third parties, records of processing, and where the data actually goes.
5. **Rank the gaps** by how likely they are to block distribution or cause a penalty, and give the smallest change that closes each.

## Grounding rules

- Cite `file:line` for the app behaviour and a source link with the date read for the rule.
- Separate three things: the rule, what the app does, and the gap. Do not merge them.
- Mark each market as "no gap found", "gaps found" or "could not confirm", and never call a market "compliant".
- Do not copy policy text from another company.

## Report

Finish with `write_report` (`kind: audit`): the markets assumed, the app profile, one section per market with rules, evidence and gaps, a list of questions for a lawyer, and what could not be verified.
