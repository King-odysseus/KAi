# Running KAI on Linux

KAI Agent Workbench is a standard VS Code extension and runs on Linux the same
way it does on Windows. This note captures the platform-specific details so a
Linux setup is friction-free.

## Prerequisites

- **VS Code** 1.96 or newer (or a compatible fork).
- **Node.js** 18+ and **npm** on your `PATH`.

## Install the agent CLIs

KAI drives external agent CLIs — install whichever you want to use globally:

```bash
npm install -g @anthropic-ai/claude-code   # claude
npm install -g @openai/codex               # codex
npm install -g @qwen-code/qwen-code        # qwen
npm install -g @google/gemini-cli          # gemini
```

On Linux, global npm binaries usually land in `~/.npm-global/bin`,
`/usr/local/bin`, or an nvm dir. Make sure that directory is on your `PATH`
(check with `which claude`). If the KAI **Settings** panel shows an agent as
"not installed" even though `which <cli>` works in your terminal, VS Code was
likely launched before the `PATH` change — restart VS Code (or launch it from a
terminal that has the updated `PATH`).

## Sign in / API keys

Same as every platform:

- **Direct route** — run the CLI's own login (`claude`, `codex login`,
  `gemini`, `qwen`). Uses your personal account.
- **Proxy route** — paste an API key in the KAI **Settings** panel. Keys are
  stored in VS Code SecretStorage (backed by the system keyring, e.g.
  libsecret/GNOME Keyring/KWallet) and injected into the agent + proxy process
  environment at launch.

## Build / package the extension

```bash
npm install
npm run compile        # tsc
npm test               # vitest (123 tests)
npm run package        # produces kai-agent-workbench-<version>.vsix
code --install-extension kai-agent-workbench-*.vsix --force
```

To develop from source, open the folder in VS Code and press **F5** to launch an
Extension Development Host.

## Operate from a browser / install as a PWA

The **Open in browser** button (Settings) runs VS Code's web server:

```bash
code serve-web --port 8000 --without-connection-token
```

This works on Linux (first run downloads the VS Code Server component). Open
`http://127.0.0.1:8000` in Chrome/Chromium and use the address-bar **Install**
icon to install it as a standalone PWA app window.

> The token is disabled for a friction-free localhost open. If you expose the
> port beyond localhost, drop `--without-connection-token` and use the printed
> token instead.

## Platform notes for contributors

- **Process spawning:** `NodeProcessRunner` only enables `shell: true` on
  Windows (to resolve npm's `.cmd` shims) and quotes arguments there via
  `quoteWinArg`. On Linux it spawns the binary directly with `shell: false`, so
  arguments (including multi-word prompts) are passed through untouched — no
  quoting needed.
- **Config paths:** agent config files resolve under the OS home dir, so Codex
  proxy-profile writing and config backups work the same on Linux.
- **Proxy / browser ports:** the proxy (default `8082`) and web server (`8000`)
  bind to localhost. If you run KAI in multiple windows at once, give each a
  distinct port to avoid collisions.
