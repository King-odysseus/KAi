---
name: task-breaker
description: This skill should be used when the user asks KAI to "break this down", "split this into tasks", "make a backlog", or "plan the cards for this". Turns a goal into small, ordered tasks, each with acceptance criteria that can be checked. Read-only.
version: 0.1.0
---

# Task Breaker

A task is ready when someone else could finish it and prove it is done.

## Boundary

- Read-only. Inspect the project, but do not change files or create board cards unless the user asks.
- Do not invent requirements. Where the goal is ambiguous, list the question instead of choosing silently.

## Workflow

1. Restate the goal in one sentence and name what is out of scope.
2. Read the project to see what already exists, so tasks build on it instead of repeating it.
3. Split the work into tasks that each change one thing and can be done in one sitting. Order them so each only depends on earlier ones; mark the dependencies.
4. Give each task 1 to 5 acceptance criteria that can be checked by reading the code or running a command. A criterion like "works well" is not allowed.
5. Mark the riskiest task and suggest doing it first.
6. List the open questions that would change the plan.

## Grounding rules

- Every task names the files or areas it will touch, from what you read.
- If a task is bigger than a day of work, split it again.

## Report

Finish with `write_report` (`kind: plan`, a specific title): the goal, the ordered tasks with dependencies and acceptance criteria, the riskiest task, and the open questions.
