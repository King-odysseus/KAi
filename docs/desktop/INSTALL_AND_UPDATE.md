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

## Checklist for a clean-machine test (not yet run)

- [ ] Install on a machine with no KAI data; confirm SmartScreen, install and first start.
- [ ] Confirm the bundled C1 and Universal Proxy engines start (Operations, Diagnostics).
- [ ] Publish a newer test release; confirm Check, Download and the release notes.
- [ ] Install it; confirm the backup exists, KAI restarts, and settings, conversations and credentials survived.
- [ ] Restore the backup and confirm settings return to their earlier values.
