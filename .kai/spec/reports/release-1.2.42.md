# KAI 1.2.42

## Your gateway is recognised as your own

- A model server on your own network now counts as local, whatever the provider is called. KAI reads the address only: a loopback or private-range address (such as `192.168.x.x`, `10.x.x.x`, `localhost`) or a `.local`/`.lan` name counts; a public address never does, so a paid cloud API is never taken for a local one.
- A gateway set up as an "OpenAI-compatible" provider at such an address is now the default Builder for Guided Build, with the model saved in Settings (for example `gateway/coding`).
- Plans that never had a Builder chosen used to fall back on the Codex agent together with the gateway's model name, which Codex cannot run ("model is not supported when using Codex with a ChatGPT account"). They now use the default Builder and save it, so the card, the Plan and team pickers and every run agree.
- Crew and the Architect treat such a gateway as a local model too, so its cards get small steps, the round limit, and the escalate-to-a-stronger-model ladder.

## Clearer Builder choices

- The "Another model…" menu (it was "With…") lists models by name: `Gateway · gateway/coding`, `Gateway · gateway/auto` and so on, taken from your saved models plus what the gateway lists right now. After those come the Coach's model and each agent that is ready, marked "(subscription)".
- A line under the buttons says what they do: Do it for me uses your Builder (named, with where it runs), set in Plan and team; Another model tries a different one for that step only.
- Labels say where a model runs: "(on this computer)" or "(on your network)".

## Version and use

- Desktop version: 1.2.42 (patch release; no breaking changes).
- Restart KAI after installing the updated desktop build.
- Roll back by installing the prior 1.2.41 build.
