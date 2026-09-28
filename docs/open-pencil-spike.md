# Spike: what open-pencil actually exposes

Slice 7.0. Written 2026-09-28 against **`@open-pencil/mcp` 0.14.0** as installed on
this machine (`%APPDATA%/npm/node_modules/@open-pencil/mcp`), with the HTTP server
running on `127.0.0.1:7600`.

**One caveat up front.** The plan says "the spike connects for real; it does not
work from this list". I could not complete a live authenticated call: the running
server has auth enabled and its token is written by the server into its own
discovery file, which I did not read. So the tool surface below is taken from the
**shipped implementation** — the `dist` bundles and `.d.mts` type files that the
running server loads — plus a live probe that reached the endpoint and was
rejected. That is stronger evidence than the plan's prose but weaker than a
successful call. Everything marked *verified* was read from code that the running
process executes; everything marked *unverified* needs one authenticated session
to confirm.

## How it runs

Two entry points, from `package.json`:

- `openpencil-mcp` → `dist/stdio.mjs` — stdio, one process per client.
- `openpencil-mcp-http` → `dist/index.mjs` — a Hono HTTP server on port 7600.

Both are launched with environment variables, so **both are configured by whoever
starts them, not by whoever connects**:

| Variable | Meaning |
| --- | --- |
| `OPENPENCIL_MCP_ROOT` | "Allowed directory for file-scoped tools (default: current working directory)". Default is cwd standalone, home directory when the desktop app spawns it. |
| `OPENPENCIL_MCP_AUTH_TOKEN` | "Bearer token for MCP and RPC auth". Absent → auth disabled. Whitespace-only → the server refuses to start. |
| `OPENPENCIL_MCP_SOCKET` | Directory for the Unix socket. |
| `OPENPENCIL_MCP_TCP` | TCP port. |
| `OPENPENCIL_MCP_DISCOVERY_PATH` | Relocates the discovery file (tests only; the desktop app ignores it). |
| `OPENPENCIL_MCP_EVAL` | Set to `1` to enable an `eval` tool. |
| `OPENPENCIL_MCP_CORS_ORIGIN` | Allowed CORS origin. |

### Discovery file

The server writes a discovery file so a client can find it without knowing the
port. Path: `getPlatformDir()/mcp.json` — on Windows
`%LOCALAPPDATA%/OpenPencil/mcp.json` (`DIR_NAME_MACOS = "OpenPencil"` is used on
every platform; the Unix name is `openpencil`). It contains `pid`, `socketPath`
(null on Windows), `httpPort`, `authRequired`, `authToken` and `startedAt`, is
written atomically with mode `0o600`, and is treated as stale when the recorded
PID is gone. The package's own docs warn that it holds a **plaintext token**.

**This is the answer to "where does the token come from":** open-pencil mints or
accepts one and publishes it here. A vault-held token only matches if the same
value was set in `OPENPENCIL_MCP_AUTH_TOKEN` when the server started. KAI reading
the discovery file at runtime is the intended client behaviour and keeps the token
off disk; KAI must never copy it into a config file.

## The answer to 7.0's four questions

**1. Does `diff_create` + `diff_show` answer "what changed since this mark"? No —
there is no mark.** *Verified.* `diff_create(from, to)` takes two node ids **in
the same document** and diffs their serialized property trees. `diff_show(id,
props)` previews what applying a *proposed* property object to one node would do.
Neither records a baseline, so neither can report drift since a point in time.
Redesign detection must therefore be **a hash of the exported tree**, which is
what the plan offers as its fallback and what KAI already does. The fallback is
not a fallback.

**2. What does `design_to_tokens` emit?** *Verified.* Params `{ format: 'css' |
'tailwind' | 'json' (default 'css'), collection?, type? }`. It returns
`{ output: string, tokenCount: number, modeCount: number }` — `output` is a
**string of text**, never a token object. With `format: 'json'` the string is:

```json
{ "<mode name>": { "--<collection-slug>-<variable-slug>": "<css value>" } }
```

Values are already formatted — colours to hex, floats to strings, aliases
resolved through the variable graph. Modes are the Figma modes (Light, Dark…).
`schemaVersion`-style metadata is absent; `tokenCount`/`modeCount` sit beside
`output`. So `.kai/spec/design/tokens.json` is a **mapping layer**, not a
passthrough: call with `format: 'json'`, parse `output`, and wrap it.

**3. Do `get_components` + a read tool give enough per component?** *Verified,
with a correction.* `get_components { name?, limit? }` returns `{ count,
components: [{ id, name, type: 'COMPONENT' | 'COMPONENT_SET', page }] }`. That is
enough for one card per component carrying its node id. `list_pages {}` returns
`{ current, pages: [{ id, name }] }`. But **`inspect_node` does not exist**, and
neither does `export_component_metadata` — for per-node detail the surface is
`get_node`, `node_tree`, `node_children`, `node_bounds` and `describe`.

**4. Is the token per session?** *Partially verified.* It is whatever
`OPENPENCIL_MCP_AUTH_TOKEN` was set to — stable for the life of the server, not
rotated per session. The plan's expectation of a 401 on a second connection is
**wrong**: the HTTP server accepts multiple clients with the same Bearer token,
and two clients were connected while this spike ran. The 401 KAI saw was a
**missing token, not a conflict** — an unauthenticated request, not a contested
one. That is a materially easier problem: it means KAI can connect alongside the
open-pencil app rather than waiting for it to disconnect.

## The real tool surface

96 core tools are registered through `ALL_TOOLS` (`CORE_TOOLS` +
`EXTENDED_TOOLS`), plus these MCP-only ones, which are RPC to the running app:
`list_documents`, `open_file`, `new_document`, `save_file`, `get_codegen_prompt`,
`get_jsx`, `export_image`, `export_svg`, `render` (and `eval` when enabled).

Every successful result is `content: [{ type: 'text', text: JSON.stringify(data,
null, 2) }]`, capped at 900 KB. **A failure is not thrown**: it is
`content: [{ type: 'text', text: '{"error": "..."}' }]` with `isError: true`.

### Names the plan lists that do not exist

Verified absent from both the core registry and the MCP-only set:

- `get_style_guide` — **not present anywhere**. The style guide cannot be pulled;
  it has to be written from the tokens.
- `export_component_metadata`, `inspect_node`, `list_shared_styles`,
  `get_design_prompt`, `get_prototype`, `create_prototype_flow`,
  `apply_design_style`.

Everything else the plan groups is present and correctly named: `list_pages`,
`get_page_tree`, `get_node`, `get_components`, `find_nodes`, `query_nodes`,
`design_to_component_map`, `design_to_tokens`, `list_variables`,
`find_variables`, `list_collections`, `analyze_colors`, `analyze_typography`,
`analyze_spacing`, `analyze_clusters`, `create_page`, `create_component`,
`create_instance`, `update_node`, `set_fill`, `set_text`, `set_layout`,
`batch_update`, `node_to_component`, `render`, `diff_create`, `diff_show`,
`diff_jsx`, `get_jsx`, `export_svg`, `export_image`. `export_pdf` exists and the
plan does not mention it.

### Two behaviours that change how calls are made

- **`get_page_tree` reads the *current page*.** It takes `{ depth?, root_id?,
  node_types? }` and returns `{ tree }` (or `{ root, tree }` with `root_id`),
  where a node is `{ id, type, name, w, h, children? }`. It is **not** a
  whole-document read: sweeping every page means `switch_page` first, per page.
  Its size cap (900 KB) is why `depth`/`node_types` exist.
- **A page name is not a node identity.** `list_pages` gives page ids, but
  `get_page_tree` with no `root_id` starts from whatever page is current, so a
  pull that wants a stable hash must `switch_page` explicitly.

## What this changed in the code

All five were applied on 2026-09-28.

1. `main/design-source.ts` — dropped `styleGuide: 'get_style_guide'`; the style
   guide stays a model-authored artifact derived from the tokens. `design_to_tokens`
   is called with `format: 'json'` and the `output` string is parsed into the
   mode-keyed map. A `{ error }` reply is surfaced as that tool's message
   (`open-pencil could not export tokens: …`) rather than as a malformed token
   document, and non-JSON `output` is refused with its own message.
2. `main/design-source.ts` — nodes are read from `tree`, not `nodes`.
3. `main/design-source.ts` — the meaningless `root` argument is gone from every
   tool call; `readDesign` takes only the ports.
4. `main/design-source.ts` — the pull sweeps pages (`switch_page` + `get_page_tree`
   per page, skipping the switch when the page is already current) and restores
   the editor's original page, so the hash covers the whole document.
5. `main/studio.ts` / `packages/contracts/src/studio.ts` — `pullDesign` no longer
   receives a style guide; it returns the `tokenCount` the editor reported and the
   UI names it. `designErrorMessage` says a 401 is a token mismatch, and a read
   outside the editor's folder names `OPENPENCIL_MCP_ROOT` as the editor's own
   setting.
6. The auth story is corrected in `domain.ts`: the token a KAI instance sends must
   equal the server's `OPENPENCIL_MCP_AUTH_TOKEN`, it is stable for the server's
   life and shared by all clients, and the discovery file is the supported way to
   obtain it. It must never be copied into a config file, a test fixture or the
   repo.

Still to confirm with one authenticated session: the exact spelling of the `tree`
node fields (`w`/`h` are ignored by KAI; only `id`/`type`/`name`/`children` are
used), and whether `list_pages.current` is a page name or an id (KAI treats it as
a name and falls back to matching nothing if it is not — the sweep is driven by
the page list, so a mismatch only costs one extra restore, never a wrong hash).
