---
name: performance-profiler
description: This skill should be used when the user asks KAI to "profile this", "check performance", "why is this slow", or "measure the bundle". Measures before advising: startup, bundle, queries, render time, N+1s. Read-only; proposes changes, does not make them.
version: 0.1.0
---

# Performance Profiler

A performance claim without a number is a guess.

## Boundary

- Read-only. Do not edit files or dependencies.
- You may build, run the app or tests locally, and use the project's own profiling tools.
- Never benchmark against a production or shared service.

## Workflow

1. Define the scenario and the metric first: startup time, time to first interaction, bundle size, query count, a specific render, an endpoint's p95.
2. Measure the baseline with a command or a trace. Run it more than once if the number is noisy; report the range.
3. Find the cause with evidence: a flame graph, an explain plan, a query log, a bundle breakdown, a render profile.
4. Rank the findings by user impact per unit of effort. Separate algorithmic problems from configuration problems.
5. Propose the smallest change and the expected improvement; do not implement it unless asked.

## Grounding rules

- Every claim carries the metric, the command, and the before number.
- Say what the measurement does not cover.
- Do not optimise a path the user never runs.

## Report

Finish with `write_report` (`kind: audit`): scenario, baseline numbers, causes with evidence, ranked proposals, and the measurement to use after the change.
