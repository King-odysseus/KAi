# KAI Remote — mobile PWA implementation plan

Status: **plan, not started.** Companion mockup: [designs/mobile-remote-mockup.html](designs/mobile-remote-mockup.html).

## Goal

Drive and monitor KAI Desktop from a phone on the same network — see what is running, get
told when something needs you, and continue or approve it without walking back to the desk.
Ships as a phone-sized web UI served by the desktop app itself, installable as a PWA.

## Non-goals

- **Not** a responsive rebuild of the desktop workbench. See Ground Rule 1 — that is the trap.
- **Not** a second engine. The desktop does the work; the phone is a console for it.
- **Not** internet-facing. LAN + optional Tailscale. No public endpoint, no cloud relay.
- **Not** full authoring parity: no Monaco, no interactive terminal typing, no Project Studio
  interview flow. Small text and decisions only.

## What the code survey established

These are the facts the plan rests on, verified in-tree:

| Finding | Source |
|---|---|
| 178 request/response channels + 9 push channels, thin wrapper over `ipcRenderer.invoke` | [preload/index.ts](apps/desktop/src/preload/index.ts) |
| All handlers registered by one wrapper `handle()` that hardcodes `ipcMain.handle` + `assertTrustedSender` | [main/ipc.ts:2158](apps/desktop/src/main/ipc.ts#L2158) |
| `assertTrustedSender` accepts only the dev URL or `file://` — **a LAN page cannot use the preload bridge** | [main/ipc.ts:2194](apps/desktop/src/main/ipc.ts#L2194) |
| `ownerWindowId` is derived from the sender's window, not the payload | [main/ipc.ts:2174](apps/desktop/src/main/ipc.ts#L2174), [:2190](apps/desktop/src/main/ipc.ts#L2190) |
| Every window carries its own `projectId` / `conversationId`; registry has `all/live/focused/send/broadcast` | [main/desktop-windows.ts](apps/desktop/src/main/desktop-windows.ts) |
| **No HTTP or WS server exists in main today.** All networking is outbound | grep under `src/` |
| `window-all-closed` quits the app on Windows — a server would die with the window | [main/index.ts:88](apps/desktop/src/main/index.ts#L88) |
| Teardown chain for long-lived services lives in `before-quit` | [main/index.ts:92](apps/desktop/src/main/index.ts#L92) |
| Renderer is a **single** vite entry; `main`/`preload` are maps (precedent for a second entry) | [electron.vite.config.ts](apps/desktop/electron.vite.config.ts) |
| `files: ["out/**/*"]` — a new bundle under `out/` is packaged with no config change | [apps/desktop/package.json](apps/desktop/package.json) |
| `agents:event` = `{ conversationId, event }`, a 17-member union; `text.delta` is the live output | [contracts/src/agents.ts:152](packages/contracts/src/agents.ts#L152), [events.ts:135](packages/contracts/src/events.ts#L135) |
| Reusable secrets pattern: `CredentialVault` + `crypto.randomBytes(32).toString('base64url')` | [main/credential-vault.ts](apps/desktop/src/main/credential-vault.ts), [service-controller.ts:605](apps/desktop/src/main/service-controller.ts#L605) |

Two consequences drive the whole design:

1. **The gateway must dispatch through the same handler bodies**, not `ipcMain.handle`. So the
   channel→handler map currently trapped inside `registerIpc`'s closures has to be extracted
   (Phase 0).
2. **A gateway has no BrowserWindow.** Window-scoped channels need a *synthetic session*. The
   clean answer is for the gateway to impersonate a chosen window — build an
   `IpcRequestContext` with that window's real session, so `ownerWindowId` resolves naturally
   and `agents:approval-response`'s owner check passes without touching its logic.

## Ground rules

1. **Build a separate mobile bundle. Do not retrofit the desktop renderer.** The workbench is
   desktop-dense — `scripts/layout-checks.mjs` fails any smoke page where a control's text
   wraps. Making that survive 390px is a far bigger job than writing the six screens from
   scratch, and it will fight every step. This one decision is most of the schedule.
2. **The allowlist is default-deny.** Once the gateway exists, its bearer token is the *only*
   thing between the LAN and 178 handlers that spawn CLIs and write files.
   `assertTrustedSender` is bypassed on this path by design — so never add a channel to the
   allowlist without asking what an attacker holding the token gets from it.
3. **Loopback by default; LAN is opt-in.** Bind `127.0.0.1` unless the user explicitly enables
   LAN mode. A token is required in both cases. Never bind `0.0.0.0`.
4. **Each phase must leave the desktop app working.** No phase may leave `npm run
   desktop:typecheck`, `npm test` or the smoke suites red.
5. **Re-read before a large edit to `ipc.ts` or `index.ts`.** Codex edits this tree
   concurrently.
6. Pre-commit checks (see [desktop working notes]): `npm run desktop:typecheck`, `npm test`,
   `npm run desktop:build`, `npm run desktop:smoke`. Do **not** run `prettier --write` on
   `apps/desktop` — it is a pre-existing baseline; formatting there is by hand.

---

## Phase 0 — Extract a channel handler registry — **DONE**

**Why first:** nothing else is possible until handlers are reachable outside
`ipcMain.handle`. Pure refactor, no user-visible change, fully covered by existing tests.

**What landed.** `registerIpc` now fills a `Map<IpcChannel, IpcChannelHandler>` and returns an
`IpcRegistry` (`channels()` + `dispatch()`); the ipcMain wiring is a loop over that map. The
local `handle` shadows the deleted module-level helper, so all **178 registration sites are
untouched** — the only handler edits were the 8 `ownerWindowId(context, request)` call sites.
`IpcRequestContext` lost its `event` field and now carries a pre-resolved `ownerWindowId`, which
makes it constructible without an `IpcMainInvokeEvent` — that is what unblocks Phase 1.

**Trap found while building it.** The first cut passed raw input straight to handlers on the
ipcMain path, silently dropping `parseIpcInput` validation for the whole renderer. Fix: validation
lives inside the map entry, the single place both paths traverse, so neither can reach a handler
body unvalidated. `test/desktop-ipc-registry.test.ts` now guards the ipcMain path specifically —
do not let Phase 1 dispatch around it.



- In `registerIpc`, collect handlers into a `Map<IpcChannel, Handler>` instead of registering
  inline; then loop that map into `ipcMain.handle` via the existing `handle()` shape.
- Export the map (or a `dispatch(channel, input, context)` helper) so the gateway can reuse
  `parseIpcInput` and `failureFor` — the validation and error-normalisation layers stay single.
- Keep `assertTrustedSender` exactly where it is: it guards the *ipcMain* path only. The gateway
  does its own auth.

**Exit criteria:** the map is built and consumed; zero behavioural change; full suite and smoke
green; a test asserts the registry covers every member of `ipcChannels`.

**Estimate:** small — one focused session.

---

## Phase 1 — Gateway core: loopback, token, read path — **DONE**

**What landed.** `apps/desktop/src/main/remote/` holds four modules — `auth.ts` (token store over
`CredentialVault` at `remote.gateway.token`, hashed constant-time compare), `allowlist.ts`
(default-deny `Partial<Record<IpcChannel, RemoteScope>>`), `dispatch.ts` (allowlist check, target
window resolution, then `registry.dispatch`), and `server.ts` (`node:http` listener). The settings
schema lives in a new `packages/contracts/src/remote.ts`, imported by `domain.ts` the way
`prompt-guide.ts` is, and reaches `appSettingsV1Schema` with a `.default()` so an existing
`settings.json` still parses. `test/desktop-gateway.test.ts` covers 25 cases on an ephemeral port.

**Decisions made while building it, worth keeping:**

- **The synthetic context is `{ session, ownerWindowId }` only.** Phase 0 removed `event` from
  `IpcRequestContext`, so the plan's `event: <shim>` is gone rather than stubbed.
- **Every route is authenticated, including health.** A phone tells "down" from "unpaired" by a
  network error versus a 401, so an open liveness probe buys nothing and leaks the port.
- **LAN mode binds the machine's private IPv4, not `0.0.0.0`.** `resolveBindAddress` returns the
  first non-internal address in a private range, and *null* — refusing to enable LAN — when there
  is none. That is Ground Rule 3 taken literally: `0.0.0.0` would also publish KAI on any VPN or
  public interface.
- **No live window means no remote request.** `ownerWindowId` is typed non-null and the handlers
  that use it expect a real window, so the gateway answers 503 rather than inventing an id. The
  consequence is deliberate: a headless KAI can be *watched* but not *driven*, and `window:new`
  staying off the allowlist means the phone cannot bring a window back.
- **A wrong `Origin` is refused, a missing one is not.** The phone app and `curl` send none; a
  random page in the user's browser sends one that does not match, and is turned away before the
  token is even checked.
- **A port that is already taken does not fail the settings save.** The write succeeds, the
  failure is logged, and it surfaces as `lastError` on `remote:status` so Settings can show it.

**Allowlist as it stands (read only):** `app:get-bootstrap`, `services:status`,
`conversations:list`, `conversations:get`, `workflows:list-runs`, `team:record`, `usage:summary`,
`context:git-diff`, `studio:board-read`, `studio:artifacts-read`, `studio:artifacts-files`.
A test asserts every key is a real `IpcChannel` and that no entry is above `read` — the first
catches a typo that would silently deny a route, the second catches a write channel added early.

**Still excluded and why:** `files:choose`, `attachments:save`, `window:new`, `projects:choose`
(native dialogs / meaningless without a window), and every `files:write`/`editor:*` channel until
Phase 4 decides each one deliberately.

**Note for Phase 3:** `GET /` currently returns a JSON stub describing the gateway. Phase 3 replaces
that route with the mobile bundle; nothing else about the routing needs to change.

---

## Phase 2 — Live stream — **DONE**

**Deviation, decided while building it: SSE, not WebSocket.** `ws` is not installed anywhere in
the tree, and adding it to the Electron main bundle would pull optional native deps in for one
feature. Server-Sent Events is plain HTTP on the listener that already exists, has no dependency,
and — the part that decided it — the browser's own `Last-Event-ID` on reconnect *is* the resume
the plan asked for, for free. The request direction already exists via `POST /api/ipc`, so nothing
is lost but a little latency on the upstream half, and the phone's uplink is a tap, not a stream.
If a bidirectional need appears later (interactive terminal typing is the only candidate, and it is
a non-goal), this is the decision to revisit.

**What landed.** `apps/desktop/src/main/remote/events.ts` holds `RemoteEventStream` — an epoch
(`crypto.randomUUID()`, because sequence numbers restart with the app and a resume point from the
previous run means something else), a 500-frame ring buffer, `since()`, `attach()`, and
`isDroppableFrame()`. `DesktopWindowRegistry` gained `subscribe()`, called from `emit()` inside
`send()`/`broadcast()`, so all nine push sites reach the phone with **no emit-site changes** —
which was the structural gap the plan named. `server.ts` serves `GET /api/events` behind the same
auth gate as everything else, and `REMOTE_PUSH_CHANNELS` moved into `packages/contracts/remote.ts`
so the gateway and the (Phase 3) mobile bundle cannot drift apart.

**Decisions made while building it, worth keeping:**

- **Frames are tagged, not filtered per connection.** Every frame carries `windowId`, and one
  stream serves the whole app; the client decides what it cares about. Per-connection filtering
  would have made the cross-window Runs screen impossible without N connections.
- **A fresh connection gets the present; a resuming one gets the gap.** Replaying the buffer at
  every connect would dump a stale tail onto a screen that then has to dedupe it. State comes from
  `/api/ipc`, the tail comes from the stream.
- **A position older than the buffer is a `resync` event, not silence.** The client is told to
  re-read state, because quietly continuing would leave a hole it could never notice.
- **Backpressure drops the tail before the connection.** Past 256 KB unflushed, `text.delta`
  frames are skipped; past 4 MB the stream is ended so the client reconnects and resumes by
  sequence. Nothing else is ever dropped — a lifecycle event is a fact, a delta is a tail.
- **The heartbeat is a comment line.** `: keep-alive` every 15s keeps idle proxies from closing a
  quiet stream without inventing an event the client would have to ignore.

**Verified by** `test/desktop-gateway.test.ts` (43 cases, 18 of them new here): the exact push
channel list cross-checked against the preload subscriptions that prove each name is real, auth on
the stream route, a push arriving with its window, renderer-only channels never forwarded, no
replay on a fresh connect, resume with neither a gap nor a duplicate, `resync` on a foreign epoch,
a client that disappears mid-run, `connectedClients` rising and falling, plus unit coverage of
eviction, the drop policy, a throwing listener, and `parseStreamPosition`.

**Not covered by tests, deliberately:** the slow-socket timing itself. Forcing `writableLength`
to grow needs a peer that stops reading, which undici will not do on demand; the tests assert the
policy (`isDroppableFrame`) and the outcome (a vanished client cannot break a run) instead. Worth
a manual check against a real throttled phone in Phase 3.

---

## Phase 3 — Mobile bundle and the first three screens — **DONE**

**The bundle is a second entry, not the workbench made narrow** (Ground Rule 1), and the three
screens — **Needs you**, **Runs**, **Run detail** — are read-only, cross-window, and filtered by
project. The renderer vite input became a map (`index` + `mobile`), `tsconfig.web.json` already
covered `src/renderer/**`, and the phone's files live in `src/renderer/mobile/`: `index.html` with
its own CSP, `main.tsx`, `App.tsx`, `store.ts` (one small `useSyncExternalStore` store), `api.ts`
and `views.tsx`, styled by `mobile.css` against the desktop's Purple tokens.

**Two decisions that change what the gateway does — both needed, both narrow:**

- **The bundle is mounted one level above it.** The build shares `/assets` between both entries, so
  a phone at `/mobile/` loads `../assets/mobile-*.js`. The gateway therefore mounts
  `out/renderer` and publishes exactly two prefixes, `/mobile/` and `/assets/`; the workbench's own
  `index.html`, sitting right there beside them, is a 404. `GET /` and `GET /mobile` redirect to
  `/mobile/` **carrying the query string**, which is the only reason a pairing link survives the hop.
- **Only `/api` is behind the token; the shell is not.** The first smoke run failed on this, and it
  was right to: gating the bundle meant a phone could never load the page that reads the token, so
  pairing was impossible and the app could not be reached at all. The bundle is a build artifact with
  no data in it — everything a phone can *learn* still arrives over `/api`, behind the same token,
  the same origin check and the same default-deny allowlist. This is also what keeps the query token
  to one route: `EventSource` cannot set a header, so `?token=` is accepted on `GET /api/events` and
  nowhere else. The pairing *link* is what now carries it — `RemoteAccessPanel` shows a link rather
  than a token to type, because the phone has no field to type one into.

**Verified by** `test/desktop-gateway.test.ts` (53 cases, 10 new here): a 503 when no bundle has been
built, `/` and `/mobile` redirecting with the query intact, `/mobile/` **not** redirecting (that was
a live redirect loop, caught by the smoke), the page and `/assets/*` served without a token with the
right types and caching, a deep link falling back to the page, the workbench page and everything
outside the two prefixes 404'd, an encoded traversal refused, a traversal written straight into a
request line 404'd, a missing script answering JSON rather than HTML, and the API still 401 with a
query token or no token at all.

**Verified end to end by** `apps/desktop/scripts/smoke-mobile.mjs` (`npm run smoke:mobile`): a real
Chromium against the real gateway, launched as the Electron app the smokes already use, on a port
taken from the OS and a temp user data directory seeded with one project and one workflow
mid-run. It asserts the phone refuses to render anything unpaired, lands on `/mobile/` with the token
stripped out of the address bar, shows the run with its real step bar and per-step output, opens the
detail and comes back, filters the Runs list by project, and refuses the four things it must
(`/index.html`, an off-allowlist channel, a query token on `/api/status`, a traversal).

**The live stream, proven from a browser:** the smoke writes a second run to disk, checks the phone
does *not* show it, then saves a setting on the desktop. The frame arrives on a raw `EventSource` in
the page with `windowId: null` (a broadcast) and a `seq`, carrying the projects; the phone re-reads
and the run appears. The check runs early enough that the 20s poll cannot be what found it.

**Not covered, deliberately:** a real slow-socket backpressure test (see Phase 2), and the phone's
composer — nothing write-side exists yet, which is Phase 4. `workflows:stop` reached from the
desktop emits no `workflows:changed` at all: the handler drops `ownerWindowId`, so
`notifyChanged` has no owner to send to. The desktop does not need the push (it gets the return
value), so it is only a gap for Phase 4, where the phone's own Stop would look like it did nothing.
Worth fixing there, when a second window can actually observe the difference.

**HTTPS note:** a service worker, and therefore installability and push, needs a secure context.
Plain LAN HTTP gives a working page but *not* a real PWA — on iOS especially, backgrounded tabs
are frozen, so nothing works without push. That makes Phase 6's HTTPS step load-bearing rather
than cosmetic, not optional polish.

**Estimate:** two to three focused sessions. **Actual:** one long session, plus the smoke finding two
real bugs in the serving path that no unit test had covered.

---

## Phase 4 — Write actions — **DONE**

- Extend the allowlist with the write scope, one channel at a time and each with a stated
  threat: `agents:run`, `agents:cancel`, `agents:pause`, `agents:resume`,
  `agents:approval-response`, `conversations:create`, `conversations:save`, `workflows:start`,
  `workflows:stop`, `workflows:resume`, `studio:board-move`, `studio:board-claim`.
- **Approvals are the acceptance test for the whole synthetic-session design.** The owner check
  in `agents:approval-response` only passes because the gateway presents a real window's
  session. If window targeting is wrong, this fails loudly — which is the point.
- Composer: quick-action verbs (Explain failure / Retry step / Summarise / Stop) plus a text
  field, with your message echoed into the run as a queued turn so delivery is visible.
- Approve/deny UI shows the literal command, the why, the risk, **and the window and path**.
  With several windows open, approving a `--force` in the wrong repo is the failure mode that
  actually costs you work.

**Open decision (not mine to make):** whether Approve needs a confirm tap. Mis-tapping a
`--force` is unrecoverable; the confirm is cheap insurance against friction on the most-used
action. Recommendation is yes, confirm, for destructive commands only.

**Exit criteria:** approve a genuine pending approval from the phone; pause and resume a live
run; continue a conversation; the desktop UI reflects every change.

**Estimate:** two to three focused sessions.

**Deviations.**
- **The allowlist is smaller than planned.** `conversations:create`, `conversations:save` and
  `workflows:start` are **not** on it. None of them has a phone caller: the console continues a
  conversation that already exists rather than starting one, and starts no new run. A channel with
  no screen behind it is surface without a use, and Ground Rule 2 says ask first.
- **Two taps for a high-risk approval** (the open decision above): the first tap arms, the second
  sends. The command, the risk, the project and the window are all shown before either.
- **An alert without a request id is not answerable** from the phone. It is shown as such rather
  than offered and then failing: `agents:approval-response` refuses without one.
- `remote:devices`, `remote:pair-device` and `remote:revoke-device` exist but are deliberately
  **not** remote-reachable, so a phone token cannot mint or revoke other devices.

---

## Phase 5 — Board, artifacts, alerts — **DONE**

- Board: read, move, claim — `get_board` already computes staleness and route.
- Artifacts: list and read spec / PRD / stories / tokens.
- Alerts: reuse the three existing kinds (`notifyRunFinished`, `notifyApproval`, `notifyBudget`)
  and fan them to the phone. Delivery needs Phase 6's HTTPS for web push; until then, a
  long-poll or SSE fallback keeps it working on the LAN.

**Estimate:** two focused sessions.

**Deviations.**
- **Artifacts are listed, not read.** The board shows each kind with its version, its writer, its
  staleness and its path; there is **no** channel that returns an artifact's text. `readText` lives
  inside `ArtifactsService` and is not exposed over IPC, and adding a channel for it is a security
  decision (Ground Rule 2) that waits for a screen that needs it.
- **A claim is named honestly.** Holding a card records `settings.defaultAgent` as the holder and
  the button reads `Hold for {agent}`, because the phone does not run the agent — it only reserves
  the card for the one the desktop would run.
- Alerts arrive while the console is open, over the existing stream. Nothing wakes a closed app:
  that is Phase 6's push, which is not built (see below).

---

## Phase 6 — PWA packaging and transport — **DONE**

- Manifest, icons, service worker, offline shell, install flow. iOS install is manual
  (Share → Add to Home Screen) and has no prompt event — expected, not a bug.
- HTTPS via Tailscale (`tailscale serve` → a real cert on `<machine>.<tailnet>.ts.net`) is the
  documented path that unlocks install + push without buying anything. Record it in `docs/`.
- Per-device tokens: pair by QR, list devices, revoke individually. This replaces the single
  shared token from Phase 1 and should land before this ships to anyone but the user.

**Estimate:** one to two focused sessions.

**Deviations.**
- **Per-device tokens landed without QR.** Pairing is a label plus a link to copy; the store keeps a
  list, the desktop lists it and revokes one device at a time. QR needed a second gateway route and
  bought nothing over the link the panel already shows, so it was left out.
- **The shell is delivered by `public/`, not by a build plugin.** `manifest.webmanifest`, `sw.js`
  and the icons sit in `src/renderer/public/mobile/`, which Vite copies to the bundle root verbatim.
  The first attempt emitted them from a plugin, which needed a `Plugin` type from the desktop's own
  vite while electron-vite types against the hoisted one — a duplicate-install mismatch with no
  upside, since a plain file copy is all this is.
- **Nothing wakes a closed app.** Alerts need the console open. Web push needs the Tailscale HTTPS
  address plus a push service, and is not built; it is recorded in `docs/desktop/MOBILE_REMOTE.md`.

---

## Risks, ranked

1. **Scope creep into making the desktop UI responsive.** Ground Rule 1 exists because this is
   the most likely way the project doubles and then stalls.
2. **Gateway auth treated as an afterthought.** The token is the only gate in front of handlers
   that execute commands. Rushed, this is remote code execution on the LAN.
3. **Stream robustness.** Reconnect, ordering and backpressure on `agents:event`. Plan for it;
   it is not free.
4. **Window-targeting mistakes.** Wrong `ownerWindowId` means approvals that silently fail or,
   worse, land in the wrong project.
5. **The desktop sleeping.** Work *and* server stop. Not a code problem, but it will look like
   one the first time it happens.

## Total

Roughly **11–17 focused sessions** end to end, with Phase 1 and Phase 4 carrying most of the
risk. Each phase is independently useful: after Phase 3 you can watch; after Phase 4 you can
steer; Phases 5–6 make it comfortable and installable.
