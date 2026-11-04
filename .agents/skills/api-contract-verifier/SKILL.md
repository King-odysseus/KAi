---
name: api-contract-verifier
description: This skill should be used when the user asks KAI to "verify the API", "check the routes against the schema", or "find undocumented endpoints". Compares the real routes, request bodies and responses with the project's spec or types. Read-only.
version: 0.1.0
---

# API Contract Verifier

The route and the schema drift apart quietly. Find where.

## Boundary

- Read-only. Do not edit files.
- You may start the project's dev server on localhost and make requests to it. Never call a deployed or external host.
- Do not send destructive requests. A read, a validation error or a harmless local payload is enough.

## Workflow

1. Find the contract: OpenAPI/Swagger, GraphQL schema, tRPC router, shared types, or the project's API docs.
2. Enumerate the real routes from the router or framework, not from the docs.
3. Compare: missing routes, undocumented routes, request fields the server ignores, response fields the client expects and never gets, status codes, auth requirements, deprecated versions.
4. Where a local server is available, prove the important differences with a request and its response.

## Grounding rules

- Every finding names both sides: `file:line` for the route and `file:line` for the contract, or the exact request and response.
- Separate "the contract is wrong", "the code is wrong", and "the contract is silent".
- Do not file style preferences as contract drift.

## Report

Finish with `write_report` (`kind: review`): each drift with both locations, the impact on a client, and the smallest correct change.
