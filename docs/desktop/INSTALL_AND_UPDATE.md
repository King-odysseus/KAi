# Installing and updating KAI Desktop

KAI is for personal, noncommercial use, so the Windows build is **not code signed**.

## Installing

1. Build the installer: `npm run dist --workspace @kai/desktop`. The NSIS installer is written to `apps/desktop/release/`.
2. Run it. Windows SmartScreen may say "Windows protected your PC" because the file is unsigned. Choose **More info**, then **Run anyway**.
3. Start KAI. Your settings, conversations, brain and stored credentials live in `%APPDATA%\KAI` and are kept when you update or reinstall.

## How updates work

KAI reads releases from GitHub (`King-odysseus/KAi`) with `electron-updater`. The release feed must be public: installed builds check it anonymously, so a private repository or an unpublished release is reported as an unavailable feed rather than an authentication failure. Every step is yours to take:

- **Check** happens after startup and every few hours if *Check automatically* is on in Settings, or when you press *Check for updates*. It only looks; it downloads nothing.
- **Download** starts when you press it. Release notes are shown first.
- **Install and restart** first saves a configuration backup named "Before update to X". If the backup fails, nothing is installed. Running work is stopped when KAI restarts.
- Development runs, unpackaged builds and the smoke tests never contact GitHub.

### Publishing a release (maintainer)

1. Bump `version` in `apps/desktop/package.json`.
2. `npm run dist --workspace @kai/desktop` creates the installer and `latest.yml` in `apps/desktop/release/`.
3. Create a GitHub Release tagged `v<version>` and attach the installer, its `.blockmap` and `latest.yml`.

## Restoring after an update

Settings, Configuration backups lists the backup made just before the update. Restore it to return settings and project permissions to how they were. Conversations, the brain and credentials are not changed by an update.

## Validation status (2026-09-24)

- [x] `desktop:typecheck`, the production build and the full automated suite
  passed (`567 passed`, `1 intentionally skipped`).
- [x] Built the unsigned NSIS installer and installed it over the development
  installation with exit code 0.
- [x] Installer: `apps/desktop/release/KAI-Setup-0.1.0.exe`, 205,434,289 bytes,
  SHA-256 `4E952A014C239CDD73FFBB9AEC82E4A0D004ECD74A2A42545AFA9969442B8772`.
- [x] Packaged and installed executable: `%LOCALAPPDATA%\Programs\KAI\KAI.exe`,
  202,690,560 bytes, SHA-256
  `096FD76D684A35BADCA3CB9C8271478A5C0BA1620DC581AE58E552DE16E00B97`.
- [x] Confirmed the installed executable hash matches `release/win-unpacked/KAI.exe`
  and that the bundled Cognitive1 1.0.0, Universal Agent Proxy 1.9.0 and
  `node-pty` Windows x64 prebuilds are present.
- [x] Passed the isolated source, unpacked-package and installed-app smoke
  suites, including project-aware Learning Tutor modes, collapsible tutor
  controls and composer, the wider resizable tutor pane, editor autosave, live
  preview and element handoff, independent windows, terminal, diagnostics,
  settings, shortcut customization and the model-menu stacking check.
- [x] Confirmed composer diagnostics default to a collapsed **Run details**
  control, zero-change checkpoint cards stay out of the conversation, and active
  runs show a rotating status phrase plus the current agent activity.
- [ ] Run the full checklist on a separate machine with no KAI data.
- [ ] Publish a newer test release; confirm Check, Download and the release notes.
- [ ] Install the published update; confirm the backup exists, KAI restarts, and
  settings, conversations and credentials survive.
- [ ] Restore the backup and confirm settings return to their earlier values.
