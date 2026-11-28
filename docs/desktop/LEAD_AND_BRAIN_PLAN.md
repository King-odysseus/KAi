# Lead, Builder and project memory

For Codex. Written 2026-11-26 against KAI Desktop 1.2.42 (commit ce07156). One phase at a time, in order.

## Goal

The goal is to help developers understand and build projects with clear, reviewable steps while keeping project-specific
design guidance and durable memory accurate.

- A **Lead** chats in the right pane: understands the project, plans, explains why, teaches and reviews.
- A **Builder** runs from the main composer: one small step at a time, fresh context, judged by checks.
- It works in Workspace **without** Project Studio.
- Every agent run in KAI builds UI the way the developer's own projects look, without being pointed at a component
  library.

This is mostly connecting and fixing what exists (Guided Build, the Architect split, step files, Learn & Code,
conventions). Do not add a new mode, a second planner, a second explain-back or a second teacher.

## Ground rules (this repo's traps)

Workspace follow-through brought forward (2026-11-28): Conversation / Code views with the existing editor, evidence-based Builder completion returned to Lead, an optional separately selected reviewer, and bounded continuation. Learn & Code retains its teaching panels. Existing Studio/spec plans remain authoritative; completion records are evidence, not a second plan. Required phase gates stay open when failed, missing or stale.

- Leave changes uncommitted unless the developer asks. They commit, push, rebuild and install themselves.
- If you do commit: the trailer is exactly `Co-Authored-By: <noreply@anthropic.com>`, and no model or agent product
  names anywhere in the message (the commit-msg hook rejects them).
- New IPC channel: contracts `ipcChannels` and input schema, preload, and `ipc.ts`; a new service needs its own late
  `ipcContext.x = x`.
- New CSS colour: run `node apps/desktop/scripts/generate-themes.mjs`. CSS variables only. Lucide icons, never emoji.
  Use the existing Flowbite wrappers (`UiButton`, `Pill`, `Select`, `TabBar`).
- Saved data must keep loading: new contract fields are optional or have `.default(...)`.
- Run targeted tests with `npx vitest run test/<file>`, background anything long. `npm run desktop:typecheck` must
  pass. `test/desktop-learning.test.ts` had a failing test on a clean HEAD on 2026-11-21; check before blaming your
  change.
- Never `taskkill` electron by name. Do not stage `.kai/`, `scratch/` or `nas-backup-kit/`.
- Another agent may edit this tree and the separate memory service. Read `git status` before editing, keep to your own files, and
  check line endings before editing `main/index.ts` and `preload/index.ts`.
- Never overwrite a file the developer wrote (follow the `AGENTS_MARKER` rule in `handoff-files.ts`).
- Back up before changing brain data, show what will change, and wait for the developer's yes.
- Not yet verified in the running app: most of Guided Build, Crew and "How you build". Look at each screen you touch.

Paths below are under `apps/desktop/src/` unless they say otherwise.

---

## Phase 1. Stop the brain teaching wrong styles (do first)

### Evidence

- `main/style-scan.ts` `readClassList` treats a missing utility class as a fact: no `rounded-*` means "square", no
  `border` means "none", no `shadow` means "none". Three unstyled elements (`card`, `card-title`, `card-body`) give
  "3 square cards, no border, no shadow".
- Existing style scans can report defaults as observed facts and produce results that conflict with project styles.
- Previously filed style notes may be stale or incorrect; preserve hand-written design guidance when reconciling them.
- Muting an item stops it being served but leaves the C1 note.

### 1.1 Count only what is seen

- In markup, count a facet only when a utility class states it. An element with no shape utility is not a sample.
- Parts of a component (`card-title`, `card-body`, `card-header`, `card-footer`, `btn-icon`, `button-group`) are not
  cards or buttons. `test/desktop-style-scan.test.ts` currently expects `.card-body` to be a card; change it.
- Join class names to stylesheet rules where possible, so a styled `.card` counts once, from its CSS.
- Resolve CSS variables used in `border-radius`, `border` and `box-shadow`. Skip what cannot be resolved (`calc`,
  unknown variables); never guess.

### 1.2 Read the whole project

- Replace the 120-file limit with a bounded pass over all style and markup files (same order of size as `repo-map.ts`).
  Keep the per-file byte cap, skip generated files, and do not block the main process.
- When a limit is hit, say so in the evidence text.

### 1.3 Serve the right project's style

- `ConventionService.briefing()` takes the project path (callers: `main/ipc.ts` `buildConversationContext`, two in
  `main/index.ts`).
- Inside a project with its own style facts, serve only that project's style lines. Never blend projects.
- With no style facts for the project, serve a style line only when the configured comparison set agrees; otherwise none.
- Rules written by the developer always come first. Stack habits must not be pushed out by style lines.

### 1.4 Retire wrong notes

- When a filed item changes or disappears, retire its old memory entry. The memory service's append operation supports
  `supersedes` and `supersedeTitle`; first check that KAI's `brain-learn` call passes them through. Store what is
  needed to find the old note beside the fingerprint in `filed`. Handle the `ambiguous` outcome.
- Retire the existing wrong notes with a dry-run list, a backup and the developer's approval. Cover the mirrored brain
  if one is configured.

### 1.5 The VS Code extension

The companion extension style scanner has the same fault. Apply 1.1 and 1.2 there.

### Accept

- Fixtures: unstyled classes give no facts; CSS pill buttons plus plain class markup give "pill"; component parts are
  ignored; two projects with different styles never appear together in one project's briefing.
- A changed convention supersedes its old note.
- A before and after report for representative projects, reviewed by a developer.

---

## Phase 2. A design profile per project

- New `main/design-profile.ts`. Read Tailwind theme settings, CSS variables, shared component classes, and the real
  code of four components: button, card, form field, page header.
- Store the actual code, source file, and a score computed by code (uses, projects, recency, developer's picks). No
  model writes or scores facts.
- Write `.kai/spec/design/profile.md` through `SpecStore`. Do not overwrite Studio's `style-guide.md` or
  `tokens.json`; where they exist and disagree, show the difference.
- A profile is a **draft** until the developer approves it in "How you build" (`ConventionsPanel.tsx`). Only approved
  profiles are served.
- Delivery: in KAI runs that touch UI (`.tsx`, `.jsx`, `.css`, or a page or component request), add the relevant parts
  within a fixed size budget (start at 6,000 characters), for local and cloud agents alike, including crew and the
  Studio design agent.
- Agents outside KAI: write root `DESIGN.md` only if it is absent or carries a KAI marker. Link it from `AGENTS.md`
  only if KAI owns that file; otherwise show the line for the developer to paste.
- Start with representative projects that exercise distinct stacks and design systems.

Accept: a UI request in a profiled project carries that project's component code; a backend request carries none; an
unapproved profile is never served; user-written files are untouched.

---

## Phase 3. Repeated memory notes (work in the separate memory service, independent of other phases)

The memory store can accumulate duplicate or outdated notes, which can crowd out useful context during recall.

1. Find what writes the repeats. Do not assume; trace it.
2. Stop it at write time, with a test.
3. Back up, dry run, then use the existing `dedupeLearnedFiles` (byte-identical only).
4. Report the entries that differ only by date and ask before removing any.

---

## Phase 3.5. Lead tab v1 (build before Phases 4–5 and the 10-task test)

- Add a resizable third **Lead** tab beside Context and Build in `RightPane.tsx`.
- Keep saved Lead chats per project, separate from Builder. Model tools remain read-only. The separate **Lead access**
  selector defaults to Read-only; **Ask before edits** previews one small correction and requires exact approval.
  **Plan edits allowed** may mark an existing authoritative plan step complete from matching Passed task evidence;
  other changes still require approval. Never overwrite an intervening file edit; refresh the diff and ask again.
- Give the Lead its own local or cloud model picker and show the selected model and the model replying.
- Reuse the Coach prompt in `guided-build-engine.ts`; do not add another planner. Explain why, how, risks and a simpler
  option in beginner language.
- **Send to Builder** copies a proposed task into the main composer without running it. If both roles are local and a
  Builder run is active, warn before sending a Lead message.
- Verify this first version with targeted tests, typecheck and a running-app screen check. Leave the remaining Phase 6
  work below for later.
- A blocker holds the affected task or phase gate open, not the whole discussion. Lead separates current evidence
  from old reports, compares recovery choices, recommends a concrete diagnostic/repair or an existing independent
  step, and asks only for the exact decision or approval needed. Unknown dependencies are not treated as independent.
  Blocked results expose **Plan ways forward** using the selected Lead model. Within existing limits, a blocked review
  may produce one recovery proposal automatically; recovery tasks require approval before Builder starts. Stop, model
  availability, spending limits and gate checks remain enforced. An unreachable endpoint does not prove missing software.
- Project Studio has no Lead tab. **Start in Workspace** opens the selected project with Workspace's Lead tab selected.
- Learn & Code keeps its Learn, Guided Build and Review teaching panels, Coach prompt, ExplainBack component,
  hands-on choices and progress store; retain old tutor/Coach turns. The development Lead stays in Workspace.
  Guided Build keeps its steps and Builder results. Do not add another planner.
- The Lead reads `.kai/spec/brief.md`, `decisions.md`, `architecture.md`, `status.md` and `risks.md` when present,
  selects whole relevant sections within a fixed budget, names omitted sections, summarizes the goal and next step,
  and marks high-risk assumptions for developer approval. Small corrections use the separate saved edit preview;
  scope, decisions and verification baselines always need explicit approval. status.md stays generated from facts.

Accept: saved chats, separate model/access/handoff settings, enforced read-only model tools, exact approved edits,
changed-file protection, evidence-backed plan maintenance and the local-model warning are verified.

---

## Phase 3.6. Lead new-idea flow and Phase 4 project memory (brought forward)

Build this with the Lead, before the remaining Phase 4–5 work and before the 10-task gate. The Lead reads the current
plan, decisions and relevant code; asks at most three questions; and explains why, how, risks, a simpler option and what
the developer will learn. It may recommend “not yet” or explain that an idea conflicts with a recorded decision. This
flow may return a multi-step proposal; the Lead remains read-only and does not write files.

- Return a structured proposal showing the exact proposed additions or changes. The developer chooses **Approve**,
  **Change** or **Park**. Change returns to the Lead; Park records the idea as undecided. No project file changes until
  the developer approves the relevant action.
- Append parked and undecided ideas to `.kai/spec/ideas.md`; append approved choices and their reasons to
  `.kai/spec/decisions.md`. Change `brief.md` only when goal or scope changes. Preserve existing text and reject a write
  if a file changed after the proposal; show the difference and request review again. Never overwrite developer edits.
- The plan has one source: the Project Studio board when one exists; otherwise `.kai/spec/plan.md`. Keep the chosen
  source aligned with Guided Build. Reuse `addIdeaPrompt` and `mergePlanProgress`; completed steps stay completed.
- Every proposed step is small and names files, done checks and a check command. The proposal states assumptions and
  risks, with high-risk assumptions still requiring approval.
- `.kai/spec/status.md` remains generated by code from observed facts.
- Test Approve, Change, Park, completed-step protection, concurrent file edits, and projects with and without Studio.

## Phase 4. Remaining project map work

- New `main/project-map.ts`, written by code: `.kai/spec/map.md` listing Django models, URLs, serializers, views and
  permissions, React routes and API calls, and how they connect. Reuse `repo-map.ts`. State what could not be
  resolved.
- When the Lead plans in a project with no brief, it proposes a one-page `.kai/spec/brief.md`: goal, rules,
  assumptions marked as assumptions. At most three questions; “just run” states assumptions instead.
- Reuse the Phase 3.6 approval and append-only rules for ideas and decisions. Do not use `ARCHITECT.md` for long-term
  decisions, because it drops old entries.
- If files and code disagree, the Lead says so and treats the code as current.

Accept: a project with no `.kai/spec` gets a brief and map after approval; an existing Studio project keeps its
content; nothing is written without approval except the code-generated map and status.

---

## Phase 5. Small task cards for local builders

- A task card: one change; files to edit; files to read only; do not touch; done checks; check command; notes.
- Extend the existing brief and step file (`packages/contracts/src/architect.ts`, `main/step-file.ts`). No new format
  beside them.
- For a small builder (`isSmallBuilder`), enforce in code: at most 3 files to edit, at least one done check, and a
  check command or an explicit "the developer checks this by eye". Reject a larger card and ask the Lead to split it
  once, then ask the developer.
- Context pack per step: brief, card, named code excerpts (extend `crew-excerpts.ts` to Workspace), notes from earlier
  steps, and the design profile for UI. Never the whole codebase.
- Checks judge the work. A builder may not weaken or delete tests to pass (keep `test-guard.ts` in force).
- Two failures on the same problem: stop, offer a smaller split, then ask. Escalate to a cloud model only if the
  developer chose one.
- Approval is required, even in Auto, for authentication, permissions, payments, database migrations and deleting
  data. Decide this in code from paths and the card, not from the model's say-so.
- Lead and Builder may both be local, the same model or two. Use a fresh context per role.

Accept: tests for card limits, the split and ask path, context pack contents, the stop rule and each approval case.

---

## Gate after Phase 4–5 task cards (the developer does this)

Run 10 small real tasks in Guided Build with a local Builder and a check command set. About 7 passing within two tries
is the signal to continue. Record what was annoying; it shapes the remaining Phase 6. The Lead tab v1 above is built
before this test; do not start the remaining Phase 6 until the developer says.

---

## Remaining Phase 6. Extend the Lead after the gate

### 6.0 Mockup first

Draw it and get approval before writing UI code.

```text
Projects | MAIN: Builder                 | RIGHT: Context | Build | Lead
         | steps, changes, check results | chat, explanations, task card
         | [composer: to Builder]        | [Send to Builder]  [ask the Lead]
```

### 6.1 Behaviour

- A third tab in `renderer/src/components/RightPane.tsx`; keep Context and Build. The pane must resize wide enough to
  read code.
- One teacher in two places: reuse the Coach in `guided-build-engine.ts` and `GuidedBuildCard.tsx`. Learn & Code and
  Workspace share the project memory and the learning record (`learning-progress.ts`).
- The Lead keeps its own chat per project, cannot edit code, and always shows its model. The composer shows the
  Builder's.
- One choice replaces today's overlapping switches: **Just run** (Lead sends steps, reviews, stops when stuck or
  approval is needed), **Guide me** (developer reads the card and presses Send to Builder), **I type, you check**. Map
  these onto the existing `participation` and `handsOn` settings so old conversations load.
- A tiny change typed into the composer runs directly, with no planning.
- New idea flow: read project files and relevant code, ask 1 to 3 questions, explain why, how, risks, a simpler option
  and what the developer will learn, wait for a decision, save it, split into cards. The Lead may say "not yet" or
  that the idea clashes with an earlier decision.
- With both roles local, take turns by default: a Lead question waits for the current step or pauses it.

### 6.2 Teach, then explain back

- Before accept, the Lead explains first: what changed, why, what could go wrong, one thing to learn.
- Then the developer says it back, using the `ExplainBack` component in `LearningPanel.tsx` (extract it; do not write
  another). The Lead corrects. Offer hint, simpler and skip.
- A setting lets the developer explain first once they are ready.
- In Just run, never block on it: give a five-line summary.

Accept: tests for the three choices, queueing, direct small changes and the shared learning record; the developer has
checked the screen in the running app.

---

## Phase 7. Scoreboard

Add to run scores (additive fields): card, minutes, tokens read and written, cached tokens when the server reports
them, passed first time, attempts, escalated. Show it per local model. Show only counted values, never estimates.
Model comparisons use the existing Evals card.

## Phase 8. Top 3 UI picker

When a project has no approved answer for a component, show up to three real previews from the developer's profiles in
the Lead tab. Save the pick to the project's profile and do not ask again. Only picks and accepted work change scores.
Previews are the hard part, since components depend on each project's CSS and data: prototype one component and report
before building the rest. Tables, navigation and page layouts come after.

## Phase 9. Simpler composer (ask first)

Propose showing **Ask, Build, Review** in `personas.ts`, with the rest under "More". Delete nothing. Build it only
after the developer approves the proposal.

## Not now

Parallel local agents, fine-tuning, a vector database.

## Report after each phase

What changed, tests and typecheck results, what was looked at in the running app, what was not verified, and anything
needing the developer's decision.
