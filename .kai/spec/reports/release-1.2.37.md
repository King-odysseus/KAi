# KAI 1.2.37

## Guided Build and planning

- Guided Build now makes beginner-friendly plans with clearer file locations and direct selection between plan steps.
- Coach and Architect planning/review runs receive a 128,000-character project map. Builder and Implementer runs keep the standard 32,000-character map, so local models stay focused on their assigned step.
- Repository map caching is separated by map size so a smaller Builder map cannot cap a subsequent Coach or Architect run.
- This release also includes the Guided Build and local-agent workflow changes committed since 1.2.36: see commits `97d24fe` through `e49df75` for the full history.

## Version and use

- Desktop version: 1.2.37 (patch release; no breaking changes).
- Restart KAI after installing the updated desktop build.
- Roll back by installing the prior 1.2.36 build.

## Build record

- Built from clean commit `4cec62b` with the desktop release workflow. Electron Vite and electron-builder completed successfully; the proxy was compiled from its pinned source before staging.
- Pinned engines: Cognitive1 `51f6797740c16d1b3df5ddcb24393eb6197c2ce4`; Universal Agent Proxy `a8c2443dee3e9c8d268475fe6387cc25fd67a0bb`.
- Installer: `../KAi-release-1.2.37/apps/desktop/release/KAI-Setup-1.2.37.exe`, 197,905,966 bytes, SHA-256 `C53B67FD614324116CFDE316ECDA7ECC216E49BC66544D92B8DFC118B52E54EF`.
- Installed from the unpacked build with `node apps/desktop/scripts/install-local.mjs --from 'C:\Users\Mega-Mind\Documents\WebDev Projects\KAi-release-1.2.37\apps\desktop\release\win-unpacked' --close`. All 9,161 files matched byte for byte; KAI relaunched with seven processes.
- Rollback: install KAI 1.2.36 after closing KAI.
