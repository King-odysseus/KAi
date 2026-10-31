# Finding record template

Each finding written to the security findings store (`SecurityFindingSaveInput`) should fill:

- `severity`: `critical` | `high` | `medium` | `low` | `info`
- `vulnClass`: short slug, e.g. `sql-injection`, `secrets-in-code`, `ssrf`, `path-traversal`,
  `insecure-deserialization`, `broken-auth`, `cors-misconfig`, `dependency-cve`
- `title`: one line, specific ("Login form accepts `' OR 1=1` and bypasses auth")
- `location`: file path for a static finding (`src/api/login.ts:42`), or `local route` + method for a dynamic one
  (`POST http://localhost:5173/api/login`)
- `evidence`: the exact input/request that triggered it and the exact (unexpected) response — enough for someone
  else to reproduce it in one step, with no live credentials or real data in the example
- `conceptCard`: written for the learner, not the fixer —
  1. What this vulnerability class is, in a sentence or two
  2. Why *this* instance of it is exploitable (the specific missing check/sanitization)
  3. The general fix pattern (parameterized queries, output encoding, allowlisting, etc.) — not just "patch this
     line," the pattern to recognize next time

## Example

```json
{
  "severity": "high",
  "vulnClass": "sql-injection",
  "title": "Search endpoint concatenates raw query into SQL",
  "location": "src/api/search.ts:18",
  "evidence": "GET /api/search?q=' OR '1'='1 returned all rows instead of zero matches, confirming the WHERE clause is built by string concatenation rather than a parameter.",
  "conceptCard": "SQL injection: user input reaches a query as literal SQL text instead of as a bound parameter, so input can rewrite the query's logic. Here `q` is concatenated directly into the WHERE clause. Fix pattern: always pass user input as a parameterized/bound value (e.g. `db.query('... WHERE name = ?', [q])`), never build SQL by string concatenation or template literals with user-controlled values."
}
```
