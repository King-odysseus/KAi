# KAI Desktop Architecture

Status: accepted for Phases 1 and 2. The Phase 3 engine packaging, lifecycle, and authenticated-loopback boundary are implemented; parity rows remain gated by service/API evidence.

## Tooling decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Desktop host | Electron | Mature Windows packaging, `safeStorage`, isolated renderer, and a narrow preload bridge |
| Build tooling | `electron-vite` | Separate main, preload, and renderer builds with TypeScript and React support |
| Renderer | React + TypeScript | Dense workbench UI without legacy webview constraints |
| Icons | `lucide-react` | Consistent accessible icons and tooltips |
| Validation | Zod | Runtime validation for IPC, settings, events, and persisted schemas |
| Persistence | Versioned JSON files with atomic replacement | Small local data sets, no native database module, recoverable backups |
| Credentials | Electron `safeStorage` | OS-backed encryption; refuses plaintext fallback |

## Process boundaries

```text
Sandboxed renderer
    |
    | contextBridge: specific methods only
    v
Preload
    |
    | validated request and response schemas
    v
Electron main
    |-- app settings and window lifecycle
    |-- secure credential vault
    |-- conversation and project persistence
    |-- diagnostics and data locations
    `-- supervised C1/proxy services and typed engine clients
```

The renderer has `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. It receives no filesystem, shell, or generic IPC function. Main validates every request and checks project scope before a privileged operation.

Live Preview is an on-demand, resizable side pane opened from the title bar. It uses an Electron `<webview>` only for the project's local dev server. The webview is created with Node integration disabled, context isolation and Chromium sandbox enabled, and a dedicated preload that exposes only element selection. Main rejects non-loopback initial attachment and later guest navigation or redirects; the preview process is owned by the main process and stopped with its process tree.

Long-running engine work runs outside the renderer. Cognitive1 and Universal Agent Proxy are pinned, staged with production dependencies, and supervised as child processes through Electron's own runtime. The system never spawns a bare `node` command from `PATH`.

## Repository layout

```text
apps/desktop/           Electron main, preload, renderer, packaging, smoke tests
packages/contracts/     Versioned domain, event, IPC, and host-interface schemas
packages/runtime/       Host-independent settings, persistence, logging, and service helpers
docs/desktop/           Baseline, architecture, parity, and release evidence
```

The existing extension remains at the repository root during extraction. It continues to compile and test independently while the desktop packages consume versioned contracts.

## Persistence

- Data lives below Electron `app.getPath('userData')`, never inside the installation directory.
- Every persisted file has a schema version and an explicit migration function.
- Writes use a temporary file plus atomic rename.
- Backups are created before destructive migrations.
- Unknown future versions are refused rather than silently downgraded.
- Conversation indexes are derived from conversation records when necessary; a corrupt index must not destroy the transcripts.

## Credentials

- Credentials are stored only in the main process.
- Electron `safeStorage` must report encryption available before any secret is written.
- If encryption is unavailable, the operation fails with an actionable error. There is no plaintext fallback.
- Renderer calls may set, clear, and query credential presence, but never retrieve the credential value.
- Logs and diagnostics redact authorization headers, API keys, tokens, and password-like fields.

## IPC contract rules

- Every request has a stable channel, a schema version, and a validated input schema.
- Every response is a discriminated success or typed error.
- Events use a versioned envelope and a discriminated payload.
- Unknown event versions are rejected at the boundary.
- Sender identity and project scope are checked in main, not trusted from renderer input.

## Service integration

Each managed engine binds an ephemeral loopback port for its private HTTP interface. KAI opens its configured public loopback endpoint in front of that private port through `AuthenticatedLoopbackGateway`. The gateway accepts either `Authorization: Bearer <token>` or `X-KAI-Loopback-Token`, rejects browser and non-loopback Host headers, strips only the KAI token from forwarded requests, and streams engine responses without buffering them.

Access tokens are generated with cryptographically secure random bytes and stored through the OS-backed credential vault. Vault writes are serialized to prevent concurrent service startup from overwriting a token. Renderer code can copy a token to the clipboard through a main-process action and rotate it, but it never receives the token value. Rotation restarts a running service so the old credential stops working immediately.

Cognitive1 data access follows the same boundary. The renderer calls narrow typed IPC methods for overview, search, and field updates. The main process obtains the current loopback endpoint and vault token through the service controller, calls Cognitive1 through the authenticated gateway, validates every response with Zod, and returns only normalized Brain records and metrics to the renderer. The gateway token is never included in renderer state, logs, or the engine request.

Services retain explicit `starting`, `stopping`, `ready`, `degraded`, and `failed` states. Readiness requires an HTTP health check against the private engine port. Stop operations escalate from graceful termination to a forced process kill and are bounded. Crash restart policy and deeper orphan-process stress coverage remain Phase 3 work.

## Parity gate

The parity register in `FEATURE_PARITY.md` controls Phase 3. No engine feature is marked integrated until it has service/API evidence and, where surfaced, a UI check. The existing embedded Cognitive1 and proxy remain compatibility implementations only.

## Phase 1 acceptance mapping

| Requirement | Implementation |
| --- | --- |
| Host interfaces | `packages/contracts/src/host.ts` |
| Versioned settings/conversation/event schemas | `packages/contracts/src/domain.ts`, `events.ts` |
| Validated IPC | `packages/contracts/src/ipc.ts` |
| Portable runtime tests | `test/desktop-contracts.test.ts` and `test/desktop-runtime.test.ts` |
| Malformed IPC/events rejected | Contract tests |
| Extension still compiles | Existing `npm run compile` |

## Phase 2 acceptance mapping

| Requirement | Implementation |
| --- | --- |
| Electron boundaries and Windows launch command | `apps/desktop/`, root `desktop:dev` script |
| Navy workbench shell | Renderer layout and navigation; production Electron smoke tests at 1440x920 and 960x640 |
| Project picker and recent projects | Main dialog service plus app-owned project settings |
| Project preferences | Validated project-scoped records in app-owned atomic JSON storage |
| Durable conversations | Atomic JSON store under app user data |
| Secure credentials | `safeStorage` credential vault |
| Single instance and window restoration | Main-process lifecycle module |
| CSP and external-link restrictions | Renderer headers and navigation handlers |
| Diagnostics and data locations | Settings view plus redacted diagnostics |

Phase 2 verification on 2026-09-23: `desktop:typecheck`, `desktop:build`, and `desktop:smoke` pass; the extension compile and 39-file/319-test baseline pass. The smoke test opens Settings, saves the validated settings update, toggles the context panel, and checks both target window sizes.
