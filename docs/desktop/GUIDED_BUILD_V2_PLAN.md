# Guided Build v2 and the model ladder

Written 2026-11-21. Supersedes the "Guided Build implementation plan" for everything it describes as the panel form.
Mockup: https://claude.ai/artifact/Y2JvERTfyUephnTSfg9C4J (sources in `scratch/gb/`, untracked).

## Why

Guided Build felt like a form, not a developer's assistant. The Coach's reply was hidden and its plan landed in five
editable boxes. Builder was a raw one-shot send with no diff review, no checks and no retry, though the Architect loop
already has all three. Learn & Code carried a second copy of the code. The goal underneath: spend subscription money
only where a strong model matters, and let local and gateway models do the rest.

## Rules that apply to every phase

- One engine (`guided-build-engine.ts`), one chat-first component. No second copy in Learn & Code or Studio.
- Coach is the Architect role, Builder is the Implementer role. Any role can be pinned to any model, local or cloud.
  The ladder is only the default for a role set to "Local first".
- A step makes one change. Reading the code is the Coach's job, done before the plan is written.
- KAI runs the project's check itself; a step cannot pass while it fails. The model never grades its own tests.
- Repo rules: commit trailer `Co-Authored-By: <noreply@anthropic.com>`, no model names; new IPC channel needs
  `ipcChannels` + preload + `ipc.ts`; new CSS colour needs the theme generator re-run; Lucide icons; targeted tests, not
  the full suite; do not stage `.kai/` or `scratch/`; contract changes keep old saved conversations loading.

## Order: Workspace, Studio, Learn & Code, Crew

### 1. Workspace
- [x] Shared engine `guided-build-engine.ts`: prompts, plan reader, review reader, chat labels, title rule.
- [x] Plan defects: one file per step enforced in code (including glued names such as `README.mdpackage.json`), steps
      that only read are dropped, conversation title from the person's words.
- [x] Workspace and Learn & Code both call the engine (the duplicate parsers and prompts are gone).
- [x] Chat-first card `GuidedBuildCard.tsx`: progress strip, the Coach's words, Do it for me / Show me the code / I'll
      edit it myself, the verdict and one Next button, model tags. The form is behind "Edit this step". Mounted in
      Workspace; Learn & Code still has its own layout (phase 3).
- [x] Builder defaults to a local or gateway model (`defaultLocalBuilder`), set when Guided Build is switched on or a
      plan is first made. Existing conversations keep what they had. Any role can still be pinned to anything.
- [x] "Check my edit" runs the project's own check through KAI (asks first), puts the result in the review, and a
      failing check overrules a "ready" from the Coach (`gateReview`).
- [x] Review gets the real diff (the project's uncommitted files, the step's own file first, at most eight, equal
      share each, cuts stated) and a hand-edited file is reviewed too.
- [x] A local Builder gets one small step, a 30-round limit and a way to say it is stuck (`<<KAI_STUCK>>`). A stuck or
      failed step offers "Retry with <Coach's model>": one run on the stronger model; the saved Builder is unchanged
      and the next step is local again.
- [x] Hands-on dial (`handsOn`: Do it for me / Walk me through it / I'll type, you check) leads with a different button
      and, in Do it for me, runs the check by itself after a clean build. "If the Builder is stuck" (`builderLock`:
      offer a stronger model / always this model) and a per-step "With..." menu that builds one step with any model
      without changing the saved Builder. Both live in the Guided Build run options; old conversations load with the
      defaults (guided, escalate).
- [x] The standalone Plan and team panel (see Crew section below for its contents); it shows counted requests, not a
      cloud-share estimate, because an estimate would be a guess.
Done when one step runs from Coach message to Builder diff to KAI test to verdict, in the chat.

### 2. Project Studio
- [x] The brief reaches the plan. Starting Guided Build from Studio stores the brief on the conversation (`brief`,
      clipped to 30,000 characters); "Make my plan now" builds the request from it (`planFromBriefPrompt`): decisions are
      kept as given, and a step that rests on a "high risk" assumption carries `needsApproval`, which waits for the
      person's OK in the card before anything is built.
- [x] Finished-screen recap (Decided, Assumed with Keep / Change / Ask me, Left to the agents) already existed from the
      interviewer plan (A1 and A2).
- [x] The button is "Start in Workspace"; the Builder defaults to the local model there too.
- [x] The Studio narrator is "Project guide" in prompts, errors and the tour; "Senior Dev" stays a Coach style only.

### 3. Learn & Code
- [x] The shared card is mounted in the side panel; the duplicate layout and parsers are gone. Review there runs KAi's
      check and reads the real diff too (`guided-build-evidence.ts`, shared with Workspace).
- [x] Learn actions: Walk me through it, Quiz me, Explain simpler (`learnPrompt`, never edits). The dial, the lock, the
      With... menu, and retry on the stronger model work the same as in Workspace.
- [x] The Coach never falls back to the Builder: with a local default Builder that would have handed planning to a
      small model.
- [x] Builder edits show in the editor through its change bars (every uncommitted line), and the file opens when the
      Builder finishes.

### 4. Crew
- [x] Model ladder: a card built by a local builder is tried `escalateAfter` times (default 2), then the stronger model
      takes that card only (the crew's chosen `escalation` target, else the Lead's). The next card starts local again.
      Setting `localFirst` is on by default and can be turned off. Escalating to another local model is refused.
- [x] Savings strip on the board and Cost tab (`crewSavings`): builds on your own models, escalations, paid spend, and an
      estimate taken from this run's own paid builds, never a price list. Tier badge on each card.
- [x] `skipUnchangedReview` is real: work whose files are byte-identical to the last review is sent back without paying
      for another review (content fingerprint, `project-fingerprint.ts`).
- [x] A question about a task that was later accepted or skipped no longer leaves the run stuck on "needs you"
      (`clearSettledAsk`); an older gap the ladder made more likely.
- [x] A local builder's card gets the start of the files it names attached (`crew-excerpts.ts`: at most three files,
      3,500 characters each, read inside the project only), so a small model does not spend its turn searching.
- [x] `lightModelForRoutine` works as its text now says: it picks a lighter setting for roles with no chosen model.
      Roles with a chosen model (every local one) keep it; the ladder, not this switch, decides local versus paid.
- [x] Plan and team panel (`GuidedBuildTeamPanel.tsx`, in Workspace and Learn & Code): the hands-on dial, who plans and
      who builds, the stuck lock, the project's check, a "Check the Builder model" button that asks the Builder's own
      server what it lists and how large a window it reports, the role pickers, a "So far" line counted from requests
      really sent (never estimated), and the plan.
- [x] My Model team (`model-team.ts`): save the Coach and Builder once; a new Guided Build plan, a new Architect and
      Implementer split (when it is switched on with no roles chosen) and a new crew (when the project has no saved
      team) start from it. Anything already set up keeps what it has. Auto keeps its own setting.

## Not built, and why
- A first-pass review by a local reviewer that can skip the strong one: skipping the strong reviewer lowers safety, so
  the strong Lead still reviews every task. Only identical work skips a second review.
- A Crew "Test this model" that runs a real edit: it needs a throwaway project and a new channel. The panel's check asks
  the server what it lists instead.
- "Retry on a stronger model" as a button on a card waiting for the person: the ladder already does this after
  `escalateAfter` attempts, and the Lead's options cover the rest.

## Decision made
- New projects default to a local Builder with escalation (Builder and Implementer local by default).
