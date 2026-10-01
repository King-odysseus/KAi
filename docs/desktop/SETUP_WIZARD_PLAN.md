# KAI Welcome & Reconfigure Wizard

## Delivered

The existing first-run checklist is now the **Welcome & reconfigure** wizard. It presents required and optional setup in one place:

1. Choose a project.
2. Set up a signed-in CLI agent or a direct API provider.
3. Optionally configure Learning Tutor, which can explain KAI and coding without sharing the Compose connection by default.
4. Optionally connect GitHub through the user-owned GitHub CLI credential store.
5. Optionally start shared memory and proxy routing.

No API or GitHub credentials are stored in the renderer or written to a project. KAI delegates GitHub authentication to `gh` and provider credentials to the OS-backed credential vault.

## Included flows

- GitHub sign-in sends the user-selected `gh auth login` command into KAI's terminal and the Git page refreshes its sign-in state.
- Setup actions deep-link to Connections or Services and access instead of leaving the user at the Settings landing page.
- KAI Guide is an optional explanation panel in the wizard. It explains local agent sign-in, API connections, storage, and which services are optional before an action is taken.
- Codex and Claude Code model preferences can be previewed and imported. Only the model string is read; KAI creates a configuration backup before saving its own preference.
- KAI Remote is surfaced in setup. It already provides authenticated per-device pairing links, device revocation, and local network controls through the Services and access section.
