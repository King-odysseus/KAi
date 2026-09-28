# KAI Remote — using the phone console

The desktop app serves a phone-sized console of its own. It is a second bundle, not the workbench made
narrow: it has its own screens, its own styles, and it only reaches the desktop through the gateway's
default-deny allowlist.

## 1. Turn the gateway on

Settings → **KAI Remote** → enable it. The gateway binds `127.0.0.1` by default, so nothing on the
network can reach it yet.

**LAN mode** (the switch beside it) binds the machine's LAN address instead. Do this only on a network
you trust: the bearer token is the only thing between the network and handlers that spawn CLIs and
write files. It never binds `0.0.0.0` — loopback and the LAN, never the world.

## 2. Pair the phone

Under the network switch, the panel shows the address to open on the phone (`http://192.168.x.x:8790/mobile/`
by default) with a copy button. It is shown whether or not network access is on, so the address is readable
before deciding about the switch, and typing it by hand lands on the page that explains the next step.

Give the device a name and choose **Pair a device**. Open the link it shows on the phone: it carries that
device's token, and the page takes the token out of the address bar as soon as it reads it and keeps it in
local storage, so it does not linger in the history or in anything shared from the phone.

A link that starts with `http://127.0.0.1` is a real link, but only from the desktop itself. For the
phone, enable LAN mode and use the address it reports.

Each device gets its own token, so **Paired devices** lists them and **Revoke** removes one without
disturbing the others. Losing a phone therefore costs one entry, not every pairing. Only the desktop can
pair or revoke: those channels are not on the phone's allowlist, so a stolen phone token cannot mint more.

## 3. What the phone can do

The console's sections are named after the desktop's, so the same word means the same thing on both
screens. Six tabs, and one of them is not a desktop section at all:

- **Needs you** — approvals waiting on a decision, runs that are waiting, running, or recently finished,
  the budget, and any push the desktop sends. An approval shows the literal command, the risk, and the
  window and project it came from; a high-risk command takes two taps to approve.
- **Workspace** — the conversations the desktop has open, newest first, each shown with the last thing
  said. Opening one shows its recent turns, whatever is arriving on the live tail, and the composer, so a
  thread that is not part of a run can still be continued from the phone.
- **Studio** — the Project Studio's board and spec catalog for one project, with moves and claims. The
  project is chosen by the console, so the Projects section opens the same board for the project it names.
- **Workflows** — every run, filtered by project, with its steps and its live output.
- **Tasks** — the C1 brain's shared task board, **read-only**: to do, in progress and done, with who holds
  each card. Starting, claiming and completing a task stays on the desktop, because starting one runs an
  agent in a new conversation. It reaches the brain through `remote:tasks`, a channel of its own rather
  than the generic `cognitive1:operation` door — which is not on the allowlist, and which is checked to be
  refused in the smoke.
- **Projects** — the projects open on the desktop, with their run and card counts. Tapping one opens its
  Studio board. Choosing, opening and removing projects stays on the desktop.
- **Composer** — on a run's detail, or on any conversation in the Workspace: send a turn into that
  conversation, and on a run also stop or resume it. The turn goes out without waiting; the live tail
  shows it arriving.

**Learn & Code** is not among them. Reading a lesson needs `learning:progress` and `learning:readiness`,
neither of which is on the allowlist; rather than a tab that refuses to load, there is no tab.

Everything else is refused by the gateway. The allowlist in
`apps/desktop/src/main/remote/allowlist.ts` is the whole surface, and it is default-deny.

## 4. Installing it on a home screen

A phone can only install a web app (and run a service worker for the offline shell) over a **secure
context**: HTTPS, or `localhost`. A plain `http://192.168.x.x` address is not one, so over the LAN the
console works but cannot be installed and has no offline shell.

### Tailscale (the documented route, no purchase needed)

1. Install Tailscale on the desktop and on the phone, and sign both into the same tailnet.
2. On the desktop: `tailscale serve --bg --https=443 http://127.0.0.1:8790` — 8790 is the gateway's
   default port, shown under Settings → **KAI Remote** if it has been changed. This publishes the gateway
   at `https://<machine>.<tailnet>.ts.net` with a real certificate.
3. Turn **LAN mode** off. The gateway can stay on loopback: Tailscale terminates HTTPS and forwards to
   it locally, so the port never has to be exposed on the LAN at all.
4. On the phone, open the Tailscale HTTPS address and use **Add to home screen** (Android/Chrome offers
   it from the console's own Install card; iOS needs Share → Add to Home Screen).

Installed from an HTTPS address, the app opens full screen and keeps its last read when the desktop is
asleep. Work stops when the desktop sleeps or Tailscale is off — that is the desktop being asleep, not
the phone losing its connection.

### Pairing an installed app

`start_url` is `/mobile/` with no token, so an installed app relies on the token it stored when it was
first paired. On iOS that token is not the one Safari stored: a home-screen web app runs in its own
container with its own storage, and its own address bar — it has none. So the console's unpaired screen
has a **paste field**: copy the pairing link on the desktop, paste it there, and the app pairs itself and
reloads into the console. Android's installed app shares its browser's storage, so it usually keeps a
token already paired, but the field works there too. If storage is cleared, pair again the same way.

## 5. What is not built yet

- **Web push.** Alerts arrive while the console is open, over the live stream. Waking a closed app needs
  push, which needs the HTTPS address above plus a push service.
- **Reading an artifact's text.** The board lists what is under `.kai/spec` with its version and staleness,
  but there is no channel that returns a file's contents to the phone. Adding one widens the surface, so it
  waits for a screen that needs it.
- **Pairing by QR.** The link is copied or typed; a QR code would save that step, and would need a second
  route on the gateway to render it.
- **Starting work from the phone.** The console continues work that exists — a turn into a run's
  conversation, stop, resume — but it cannot open a new conversation or start a workflow. That is
  `conversations:create`, `conversations:save` and `workflows:start`, none of which is on the allowlist:
  they are the widest writes the desktop has, since they spawn CLIs and write files. They wait for a
  deliberate decision rather than arriving with a screen.
