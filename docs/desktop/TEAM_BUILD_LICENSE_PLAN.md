# Team build with an online license: plan

Status: plan only. Nothing here is implemented.

## Goal

Give a teammate their own KAI installer that must be activated with a license key. The owner can cancel, extend or
move a key at any time from a small admin page. The owner's own build is unchanged and never asks for a key.

The teammate runs it on their own computer, so no ports, config files or user-data folders are shared with the
owner's copy.

## Decisions (made)

| Question | Decision |
|---|---|
| How is a key checked? | Online, against a small service hosted on Railway. |
| What if the teammate is offline? | The app keeps working for 7 days after the last good check, then asks for internet. |
| What happens when a key is cancelled or expires? | The app locks at its next check. It never touches the teammate's projects or conversations; they are still there when a working key is entered. |
| Machines per key | One. |
| How is a machine identified? | A random id the app creates on first run and keeps in its user-data folder. |
| Database | Railway Postgres. |
| How are keys issued and managed? | A small admin web page on the same service. |
| Installer name | "KAI Team", app id `ai.kai.desktop.team`. |
| Updates | Off in the team build. The owner hands over a new installer when there is one. An old key keeps working with a newer app until the key's own expiry date, because keys belong to a person, not to an app version. |

## Known limit

An online check in a desktop app can still be bypassed by someone determined, because the check lives in an app on
their computer. This stops casual sharing, leaving, and leaked keys. It is not copy protection.

## How it works

1. The admin page creates a key such as `KAI-7F3Q-92KD-X4M8` for a named person, with an optional expiry date. The
   key is shown once.
2. The teammate installs the team build and pastes the key into the activation window.
3. The app sends the key, its random machine id and its version to the service. The first time a key is used, the
   service binds it to that machine.
4. The service answers with a **lease**: a small signed note that says "this key, on this machine, is good until
   <date>". The date is 7 days from now, or the key's expiry if that is sooner.
5. The app saves the lease. On every launch, and about once a day while running, it asks for a fresh one.
6. Offline, the app runs on the saved lease. Once the lease date passes, it shows the activation window.

What the app does with each answer:

| Answer | App behaviour |
|---|---|
| New lease | Keep working. Save it. |
| The service explicitly says no: key not found, expired, revoked, or used on another machine | Lock now. Delete the saved lease. Show the reason. |
| No connection, timeout, or a 5xx from the service | Keep working on the saved lease until its date. An outage on the owner's side never locks the teammate out early. |
| Saved lease is past its date and the service cannot be reached | Show the activation window and say that internet is needed. |

The lease is signed (Ed25519) by the service, so editing the saved file does not extend it. The app also remembers the
latest time it has seen, and treats a clock that has gone backwards as a reason to ask the service again.

## Pieces

### A. The license service (`services/license-server/`, deployed on Railway)

Its own small package, separate from the desktop build. Node and TypeScript, one HTTP server, one Postgres database.

**Public endpoints**
- `POST /v1/lease` takes `{ code, machineId, appVersion }`. It binds an unused key to the machine, checks the key
  against the rules above and returns `{ lease }` or `{ reason }` where reason is one of `invalid`, `expired`,
  `revoked`, `machine_mismatch`. One endpoint covers first activation and later check-ins.
- `GET /health` for Railway.

**Admin page** (`/admin`, one server-rendered page, no front-end framework)
- Sign in with a password. Signed, HttpOnly, Secure, SameSite=Strict session cookie, a form token on every change,
  and a lockout after repeated wrong passwords.
- List of keys: name, email, last four characters of the key, expiry, status, machine bound, last check-in, app
  version.
- Create a key (name, email, optional expiry). Shows the full key once and never again. A lost key is replaced by
  making a new one.
- Extend or change an expiry. Revoke. Release the machine (for a reinstall or a new PC).
- An activity log per key: activated, checked in, denied and why, revoked, released.
- Export the key list as CSV, as a backup the owner can keep.

**Data** (Postgres)
- `licenses`: id, name, email, code hash, last four characters, expires at, revoked at, machine id hash, bound at,
  last check at, last app version, created at.
- `license_events`: license id, time, type, detail.
- Keys are stored as a salted hash, so a leaked database does not leak working keys.

**Safety**
- HTTPS only (Railway provides it).
- Rate limits per address and per key on `/v1/lease`, constant-time comparisons, the same message for "not found" and
  "wrong", and no full keys in logs.
- Railway environment variables: `DATABASE_URL`, `LICENSE_SIGNING_KEY` (private), `ADMIN_PASSWORD`,
  `SESSION_SECRET`, `KEY_PEPPER`.
- Leases carry a key id (`kid`) so the signing key can be rotated later. A rotation means a new team build, since the
  public key is inside the app.
- Migrations run when the service starts.

### B. The app side (in `apps/desktop`)

- `src/main/license.ts`: pure logic. Verifies a lease's signature, machine, dates and clock, and decides keep working,
  lock, or ask again. No network, so it can be tested directly.
- `src/main/license-client.ts`: sends the request with a short timeout and sorts the outcome into "explicit no",
  "unreachable" or "new lease". Refuses a non-HTTPS server address.
- `src/main/license-store.ts`: reads and writes the machine id and the lease in the user-data folder.
- `src/main/license-gate.ts` and `src/preload/license.ts`: the activation window. It has its own small preload and its
  own IPC channel, so it does not touch the main IPC contracts or the renderer. It shows the reason when a key fails
  and explicit text when internet is needed.
- `src/main/index.ts`:
  - The gate runs first in `startApplication`, before any store, service or window.
  - It is on only when `resources/license/config.json` (service address) and `public.pem` exist, which only the team
    build ships. Dev runs, smoke tests and the owner's build have neither, so they start as normal.
  - The activation window stays open until the main window exists. Otherwise Electron's `window-all-closed` handler
    quits the app between the two.
  - The `second-instance` and `activate` handlers focus the activation window while it is open.
  - Headless `kai run` launches go through the same gate.
  - A daily re-check runs while the app is open. On an explicit "no" the app saves its state, shuts down through the
    existing quit path and tells the user why. The next launch shows the activation window. Conversations are already
    saved to disk, so nothing is lost.
  - The updater's `enabled` also requires that the gate is not active.
- `electron.vite.config.ts`: add `license` to the preload inputs, as `preview` already is.

### C. The team build (`apps/desktop/scripts/build-team.mjs`)

- Needs `build-team/license/public.pem` and `config.json`, and says what is missing if they are not there.
- Runs the existing engine staging and `electron-vite build`, then calls electron-builder's JS API with the build
  config changed:
  - `appId: ai.kai.desktop.team`, `productName: KAI Team`
  - `artifactName: KAI-Team-Setup-${version}.${ext}`, `directories.output: release-team`
  - `publish: null`
  - an extra resource copying `build-team/license` to `license`
- Package scripts: `team:dist`.
- `.gitignore`: `apps/desktop/build-team/` and `apps/desktop/release-team/`.

## Build order

1. **Service core.** Data layer behind an interface (Postgres, plus an in-memory version for tests), the lease logic,
   `/v1/lease` and `/health`.
2. **Admin page.** Sign-in, key list, create, extend, revoke, release, activity log, CSV export.
3. **Deploy to Railway.** Postgres plugin, environment variables, domain, health check. Create the signing key, copy
   its public half into the team build folder.
4. **App side.** `license.ts` first with tests, then the client, store, activation window and the `index.ts` gate.
5. **Team build script** and the updater switch.
6. **Walkthrough** on a second machine or a clean Windows user account.

Steps 1 and 4 do not depend on each other and can be built in either order once the lease format is agreed.

## Tests

**Service**
- Key state rules: unused key binds to the first machine; a second machine gets `machine_mismatch`; revoked and
  expired keys are refused; extending an expiry reopens an expired key; releasing a machine lets a new one bind.
- A lease never outlasts the key's own expiry.
- Admin: wrong password, lockout, a form without its token is refused, the key is shown once.
- Rate limiting and "not found" and "wrong" returning the same message.

**App**
- `license.ts` with a fake clock: valid lease, edited lease, wrong machine, expired lease, clock moved backwards.
- Outcome sorting: explicit no locks and deletes the lease; timeout, offline and 5xx keep the saved lease.
- Seven-day boundary: day 6 works offline, day 8 asks for internet.
- Gate logic: no config means no gate; a good saved lease means no window.
- The normal build's package contents do not include `license/`.

## Manual check before handing over

1. Make a key for a test person on the admin page.
2. Build the team installer and install it on another machine.
3. A wrong key shows the reason. The right key starts KAI. The same key on a second machine is refused.
4. Release the machine on the admin page, then activate on the second one.
5. Go offline for a launch: it works. Revoke the key and relaunch online: it locks, and the projects are still there.
6. Set the machine's date forward 8 days while offline: it asks for internet.
7. Confirm the owner's normal build still starts with no prompt and still updates.

## Later, if needed
- Show "Licensed to <name>, valid until <date>" in Settings.
- More than one machine per key, or key tiers for a bigger team.
- Email the owner when a key is denied several times in a row.

## Open items before building
- Pick the admin password, and keep it in a password manager.
- Choose the Railway domain or custom domain for the service address that goes into the team build.
- Decide where the service code lives: inside this repository under `services/license-server/`, or in its own
  repository. The plan assumes the first.
