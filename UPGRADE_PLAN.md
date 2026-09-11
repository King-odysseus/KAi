# KAI Upgrade Plan

Implementation plan for the KAI Agent Workbench upgrade: the correctness fixes
found in review, plus the redesigned chat UI. Written to be executed one phase
at a time by a coding agent (Qwen Code), with a human review between phases.

## How to run this plan

Start each agent session with:

> Read `UPGRADE_PLAN.md` in full, then implement **Phase N only**. Work through
> its tasks in order. After each task run the checks listed under "Ground
> rules". Stop when the phase's "Done when" list is satisfied, and finish with a
> summary: tasks done, files changed, anything skipped and why.

Do phases in order. Phase 0 unblocks everything else; later phases assume it.

## Ground rules (every phase)

1. **Read before editing.** Read every file a task names, in full, before
   changing it. Match the surrounding style.
2. **Checks after every task:** `npm run compile`, `npm test`, `npm run lint`.
   - `compile` and `test` must pass before moving on. Never delete or skip a
     failing test to get green; fix the cause or stop and report.
   - `lint` has pre-existing errors, so it exits non-zero; that is expected.
     Baseline (2026-09-11, after task 0.1):
     `npx eslint src/ --ext .ts` → **250 errors, 9 warnings**;
     `npx eslint test/ --ext .ts` → 106 errors, 14 warnings.
   - The rule applies to **`src/` only**: its totals must not go above the
     `src/` baseline, and `npx eslint <src files you changed> --format unix`
     must show nothing on lines you wrote. When you fix a `src/` lint error
     on a line you touched anyway, lower the baseline number here.
   - `test/` is exempt: its VS Code mocks (e.g. `mockConfig`) return `any`,
     so every new test trips `no-unsafe-*` rules. Follow the existing test
     style and ignore those.
   - Don't fix unrelated lint errors, don't add `eslint-disable` comments,
     and don't change the ESLint config.
   - Dependencies are installed. Don't run `npm install` or change
     `package.json` / `package-lock.json` unless a task says to.
3. **Tests for logic.** Any change in `src/adapters`, `src/core`,
   `src/orchestrator`, `src/config` or `src/proxy` gets a vitest test in
   `test/`. Use real CLI output shapes as fixtures, not invented ones.
4. **Unsure about a CLI flag? Check it.** Run `claude --help`,
   `codex exec --help`, `qwen --help` or `gemini --help` and use the flag
   exactly as printed. Do not guess flag names from memory.
5. **Webview code** (`src/panel/workbench.js`, `workbench.css`):
   - Plain ES5 inside the existing IIFE. No frameworks, no build step, no new
     npm dependencies.
   - CSP: no inline `on*=` handlers, no external URLs, no `eval`. Add
     listeners with `addEventListener`.
   - Anything that came from an agent, a file, or the user goes through
     `esc()` or `textContent`. Never put raw text into `innerHTML`.
   - Colours come from `--vscode-*` variables or the `--kai-*` tokens below.
     No new hard-coded hex values outside the token block.
6. **Scope.** Do only the current phase. No drive-by refactors. Do not touch
   user config files (`~/.claude`, `~/.codex`, `~/.qwen`), `.kai-backups/`, or
   git history. Do not commit; leave changes in the working tree.
7. **Changelog.** Add a dated entry to `updates.md` (newest first, same style
   as existing entries) describing what the phase changed for the user.

## Design reference

The target UI is in `docs/design/*.dc.html`: static HTML with inline styles,
one file per screen. Copy spacing, sizes and structure from the markup.
Rendered PNGs of the same screens are in `designs/*@2x.png` if you can view
images.

| File | Screen |
|---|---|
| `Main.dc.html` | Chat: reply header, tool group, memory and thinking chips, markdown, diff summary, approval card, tasks, queue, composer |
| `Composer.dc.html` | Permission mode menu, @ context menu, agent and route menu |
| `Workflow.dc.html` | Workflow run stepper with a failed step |
| `History.dc.html` | Conversations list |
| `Review.dc.html` | Diff review in a VS Code editor tab |
| `Compare.dc.html` | Two-agent compare in an editor tab |

The design files use literal Dark Modern colours. When implementing, map them
to theme variables. Add these tokens to the `:root` block of `workbench.css`:

```css
--kai-agent-claude: #e0976f;
--kai-agent-codex:  #62c4a0;
--kai-agent-qwen:   #a996e6;
--kai-agent-gemini: #d2b55b;
--kai-add:    var(--vscode-gitDecoration-addedResourceForeground, #89d185);
--kai-remove: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
--kai-memory: var(--vscode-charts-purple);
--kai-warn:   var(--vscode-charts-orange);
```

Tinted surfaces use the existing pattern:
`color-mix(in srgb, var(--kai-warn) 7%, var(--kai-surface))`.

---

## Phase 0: Fix blockers

Backend correctness. No visible UI change except that things start working.

### 0.1 Proxy base URL keeps `/v1`
- **Files:** `src/config/proxy-config.ts` (`normalizeBaseUrl`, near the end),
  `test/proxy-config.test.ts`.
- **Why:** the proxy appends `chat/completions` straight onto the base URL
  (`src/proxy/proxy-server.ts`, `new URL('chat/completions', …)`). Stripping
  `/v1` turns `https://api.groq.com/openai/v1` into
  `…/openai/chat/completions`, which returns 404. The same breaks OpenAI,
  Together, Moonshot, Ollama and LM Studio.
- **Do:** strip only `/anthropic/v1` and `/anthropic`. Replace the
  "strips /v1 suffix" test with tests asserting that
  `https://api.groq.com/openai/v1`, `https://api.openai.com/v1` and
  `http://localhost:11434/v1` are returned unchanged.

### 0.2 Parsers can return several events per line
- **Files:** `src/adapters/process-agent-adapter.ts` (`StreamLineParser`
  type, `mapOutput`), `src/adapters/acp-adapter.ts` (`parseOutput`), all four
  `*-parser.ts` files.
- **Do:** change `StreamLineParser` to return
  `WorkbenchEvent | WorkbenchEvent[] | null`. Callers normalise to an array
  and yield each event. Existing parsers keep working unchanged.

### 0.3 Claude parser shows the reply
- **Files:** `src/adapters/claude-parser.ts`, `test/claude-parser.test.ts`.
- **Bug:** the parser checks `event.usage` before `type === 'result'`. Real
  `claude -p --output-format json` output always includes `usage`, so the
  reply text is dropped and only a cost event is emitted.
- **Do:** for `type: 'result'`, return
  `[text.delta(result), cost.update(usage, amountUsd = total_cost_usd)]`. Keep
  `session_id` on the lifecycle/cost event (add an optional
  `sessionId?: string` to `CostUpdateEvent` in `src/core/events.ts`); Phase 4
  uses it. In `parseAssistantEvent`, return an event for **every** content
  block, not just the first.
- **Test fixture** (use this exact shape):
  `{"type":"result","subtype":"success","is_error":false,"result":"Here is the answer.","session_id":"abc","total_cost_usd":0.0123,"usage":{"input_tokens":1200,"output_tokens":40}}`
  must produce one `text.delta` and one `cost.update` with `amountUsd: 0.0123`.

### 0.4 Buffer partial lines across stdout chunks
- **Files:** `src/adapters/process-agent-adapter.ts` (`mapOutput`),
  `src/adapters/acp-adapter.ts` (`parseOutput`).
- **Bug:** each chunk is split on newlines on its own. A long JSON line that
  arrives in several chunks becomes broken fragments.
- **Do:** keep a carry-over buffer per stream per run. Only complete lines
  are parsed; the remainder waits for the next chunk; flush it when the
  process exits. Test: one JSON line split across three chunks yields exactly
  one parsed event.

### 0.5 Pass prompts on stdin, not argv
- **Files:** `src/adapters/process-runner.ts` (`run`), `buildClaudeArgs`,
  `buildCodexArgs`, `src/adapters/acp-adapter.ts`.
- **Why:** on Windows the prompt goes through `cmd.exe`, which expands
  `%VAR%` and mangles newlines.
- **Do:** add an optional `stdin?: string` to `ProcessRunner.run`; write it and
  close stdin after spawn. Claude: `claude -p` reads the prompt from stdin when
  it's not given as an argument. Codex: check `codex exec --help` for the
  stdin form (typically `-` as the prompt). Confirm both with `--help` before
  coding. Update `test/process-runner.test.ts` and
  `test/process-agent-adapter.test.ts`.

### 0.6 Claude respects the autonomy setting
- **Files:** `buildClaudeArgs` in `src/adapters/process-agent-adapter.ts`.
- **Bug:** no permission flag is passed, so Claude in `-p` mode can't edit in
  any mode.
- **Do:** run `claude --help` and find the permission-mode flag and its
  values. Map `review` to the ask/default mode and `auto` to the
  accept-edits mode. Leave `custom` like `review` until Phase 2 redefines the
  modes. Unit-test the argument mapping.

### 0.7 Diff applier never corrupts files
- **Files:** `src/orchestrator/vscode-diff-applier.ts`,
  `test/vscode-diff-applier.test.ts`.
- **Do:**
  - Remove content-mismatch tolerance. `findPattern` must match context
    exactly; only the *position* may drift (search the whole file).
  - If a hunk doesn't match, return `{ applied: false, detail: 'Hunk N did not apply' }`.
    Never apply at the header position blindly.
  - Preserve the file's original line endings (detect `\r\n` and rejoin with it).
  - In `diffToNewContent`, skip `+++`/`---` header lines *before* checking for
    a leading `+`.
  - Resolve relative `filePath` against the first workspace folder.

### 0.8 Hide compare mode until Phase 5
- **Files:** `src/panel/workbench.js`, `src/panel/workbench-view-provider.ts`.
- **Why:** the ⇶ button has no handler; `activeCompare` is undeclared (it
  throws in strict mode) and `renderCompareSummary` doesn't exist.
- **Do:** remove the compare button and `#agentB` from the HTML. Declare
  `var activeCompare = null;` and guard the `compareId` branch so a stray
  compare event can't throw.

### 0.9 Housekeeping
- Add `docs/**` and `UPGRADE_PLAN.md` to `.vscodeignore`.

**Done when:** all checks pass; with the proxy on and a Groq base URL, a
request reaches `/openai/v1/chat/completions`; a Claude run in the workbench
shows its reply text and a cost; a multi-line prompt containing `%PATH%`
arrives unchanged.

---

## Phase 1: Chat rendering

UI only, in `workbench.js` and `workbench.css` (plus small message additions
in `workbench-view-provider.ts`). Reference: `docs/design/Main.dc.html`.

### 1.1 Theme tokens
Add the token block from "Design reference". Replace the hard-coded hex
colours in `workbench.css` (plan editor, plan progress, compare and
quick-rerun sections) with `--vscode-*` variables or `--kai-*` tokens.

### 1.2 Markdown
Create `src/panel/markdown.js`. Load it with the same nonce as `workbench.js`
and allow it in `.vscodeignore` like the other panel files. It exposes
`window.kaiMarkdown(text) → html`:
- **Escape HTML first**, then add markup. The output can only contain tags the
  renderer itself emits.
- Support fenced code blocks (language label plus a Copy button in a header
  strip), inline code, bold, italic, headings (render as bold lines),
  bullet/numbered lists, paragraphs, and links (`http(s)` only; clicks go to
  the extension, which opens them with `vscode.env.openExternal`).
- While a reply streams, re-render the whole message from its accumulated
  text, at most once per animation frame.

### 1.3 Reply layout
Replies drop the bubble and left border. Each reply gets a header row:
agent-colour dot and name, a route chip (`Proxy · <model>` or `Direct`), cost
(green, from `cost.update.amountUsd`), and elapsed time on the right. User
messages keep the sky-blue bubble. Match `Main.dc.html`.

### 1.4 Tool call group
Consecutive `tool.call` events in one reply collapse into a single card: a
header reading "Ran N tools" with a per-tool-name tally (`Read ×3 · Grep`),
and a chevron to expand. Expanded rows show an icon, tool name, a one-line
input summary (`file_path`, `path`, `command` or `pattern` if present), and
the status. Collapsed by default. Keep the existing **Details** toggle for raw
telemetry.

### 1.5 Memory and thinking chips
- `memory.event` with `recall`: a purple "Used N memories" chip under the
  reply header (N parsed from "Recall found N"). Clicking expands the recall
  text.
- `text.delta` with `channel: 'summary'`: a collapsed "Thought" chip holding
  the text.

### 1.6 Message actions
Under each finished reply:
- **Copy:** `navigator.clipboard.writeText` of the reply's raw text.
- **Retry:** resend the previous prompt with the same agent.
- **Continue with ▾:** a small menu of the other agents; picking one sends
  `{type:'handoff', targetAgent}`.

### 1.7 Handle the capabilities message
`workbench.js` currently ignores the `capabilities` message. Store it, and
mark unavailable agents (dimmed, with `unavailableReason` as a tooltip)
wherever agents are listed.

### 1.8 Notify when done or blocked
In `src/extension.ts`, when a run finishes after more than 20 seconds, or an
`approval.request` arrives, while the KAI view isn't visible: show
`vscode.window.showInformationMessage` with an **Open** button, and set
`webviewView.badge` (count of unseen finished runs). Clear the badge when the
view becomes visible.

**Done when:** a Claude reply with a code block renders formatted with a
working Copy button; tool calls show as one collapsible group; the reply header
shows agent, route and cost; the UI looks right in Dark Modern, Light Modern
and High Contrast themes.

---

## Phase 2: Composer

Reference: `docs/design/Main.dc.html` (bottom) and
`docs/design/Composer.dc.html`.

### 2.1 Permission modes
- **Files:** `src/core/types.ts`, `src/core/permissions.ts`,
  `test/permissions.test.ts`, `package.json` (`kai.defaultAutonomy` enum),
  `src/config/project-preferences.ts`, `buildClaudeArgs`, `buildCodexArgs`,
  `src/extension.ts` (`cycleAutonomy`, `setAutonomy`).
- **Do:** replace `review | auto | custom` with
  `plan | ask | autoEdit | full | custom`:

  | Mode | Label | Description | Claude | Codex |
  |---|---|---|---|---|
  | `plan` | Plan | Read-only. Looks around and proposes a plan before touching any file. | plan mode | `--sandbox read-only` |
  | `ask` | Ask before edits | Asks before each file edit and command. | default mode | `--sandbox read-only` |
  | `autoEdit` | Edit automatically | Edits files without asking. Still asks before risky commands. | accept-edits mode | `--sandbox workspace-write` |
  | `full` | Full access | Never asks. Best inside a worktree or a sandbox. | bypass mode | check `codex exec --help` for full access |
  | `custom` | Custom… | Choose which actions need approval. | derive from the profile | derive from the profile |

  Confirm the exact flag values with `--help`. `full` must require a one-time
  confirmation dialog per workspace.
- **Migration:** stored preferences and settings map `review` → `ask` and
  `auto` → `autoEdit`.
- **Custom:** a checklist of the `PermissionKey`s, saved per workspace in
  `workspaceState`. `createPermissionProfile('custom')` reads it.

### 2.2 New composer
Replace the three `<select>`s and the template row with the composer in the
design:
- A bordered box containing a context-chip row, the textarea, and a toolbar:
  attach, @, mode chip, agent/route chip, context meter, send.
- Templates move into the `/` slash menu.
- The mode chip opens the mode menu (label and description per mode, a tick
  on the current one, "Custom…" at the bottom). Shift+Tab in the textarea
  cycles modes.
- The agent chip opens one menu listing each agent with a Direct/Proxy
  segmented control, its model, and its price (or "Included" for Direct).
  Unavailable agents are dimmed and show "Install…", which opens a terminal
  prefilled with that agent's `installCommand` from
  `src/config/agent-catalog.ts` (the user presses Enter to run it).
- Popovers close on Escape and on outside click, and are keyboard navigable
  (Up/Down/Enter).

### 2.3 Context
- **Active file chip:** the extension posts `{type:'activeFile', path}` on
  `vscode.window.onDidChangeActiveTextEditor`. The chip has an eye toggle to
  include or exclude it.
- **@ menu:** typing `@` opens a menu. File results come from
  `vscode.workspace.findFiles` (the extension handles `{type:'searchFiles', query}`,
  max 20, excluding `node_modules`). Extra entries: Current selection,
  Uncommitted changes (`git diff --stat`), Search memory (Cognitive1 recall).
- **Editor right-click:** add a `KAI: Add Selection to Chat` command to the
  `editor/context` menu in `package.json`, bound to `alt+k`. It adds a
  `path:start-end` chip.
- **Paste or drop images:** save to the extension's `globalStorageUri`, then
  show a thumbnail chip.
- **Prompt assembly:** chips become a preamble before the user's text:
  `Context:\n- src/a.ts\n- src/b.ts:10-40 (selection)\n- image: <path>\n\n<prompt>`.
  Put this in a pure function with unit tests.

### 2.4 Queue and steer
While a run is active:
- Enter adds the message to a queue shown above the input (dashed rows with
  edit and remove).
- When the run completes, the next queued message sends automatically.
- Ctrl+Shift+Enter stops the current run and sends the message immediately.

### 2.5 Context meter
A small ring in the toolbar shows the percentage of the model's context used
(sum of input tokens from this conversation's `cost.update` events against a
per-model context size table in `src/core/cost-estimator.ts`). The footer
shows session cost and total tokens. Remove the old pre-send cost estimate
line.

**Done when:** modes map to the right CLI flags (unit-tested); the @ menu
inserts file chips that reach the agent in the prompt; queued messages send in
order after the run ends; old `review`/`auto` preferences load as `ask`/`autoEdit`.

---

## Phase 3: Checkpoints, diff review, approvals

Reference: `Main.dc.html` (diff summary, approval card) and `Review.dc.html`.

### 3.1 Checkpoints
- **Files:** new `src/orchestrator/checkpoints.ts` plus tests.
- At the start of every run, record a checkpoint: `git stash create` (it
  doesn't touch the working tree) gives a commit of the current state; if it
  prints nothing (clean tree), use `HEAD`.
- Also record untracked files (`git ls-files --others --exclude-standard`) so
  files the run creates can be removed on undo.
- Store `{taskId, ref, untracked}` per turn.
- If the workspace isn't a git repo, disable checkpoint features and show why.

### 3.2 Diff summary card
When a run ends, run `git diff --numstat <ref>` (plus new untracked files) and
emit a new `turn.changes` event `{files: [{path, added, removed}]}`. Render the
card from the design: "N files changed +A −R", per-file rows, **Review in
editor**, **Keep all**, **Undo all**. **Undo all** restores those files from
the checkpoint and deletes the new ones, after a confirmation dialog.

### 3.3 Review in the diff editor
- Register a `TextDocumentContentProvider` for the scheme `kai-checkpoint`
  that serves a file's content at the checkpoint (`git show <ref>:<path>`).
- **Review in editor** opens
  `vscode.diff(checkpointUri, fileUri, '<name> (Before ↔ <Agent>\'s edit)')`.
- Add editor-title commands `KAI: Accept`, `KAI: Reject`,
  `KAI: Accept All` and `KAI: Next Changed File`, shown with
  `when: resourceScheme == kai-checkpoint` (or a context key).
- **Reject** restores that file from the checkpoint.

### 3.4 Rewind to here
Each user message gets a **Rewind code to here** action. It restores the
working tree to that turn's checkpoint, after confirmation.

### 3.5 Approval cards
- Render `approval.request` as in the design: title, risk chip, the command or
  file in a code block, and **Allow once** / **Always allow <thing>** / **Deny**.
- Add `orchestrator.respondToApproval(eventId, 'once' | 'always' | 'deny')`.
  **Always** rules persist in `workspaceState` and are checked before a
  request is shown.
- Add an optional `respondToApproval` to the `AgentAdapter` interface. The
  adapters that can really pause for approval arrive in Phase 6; until then,
  this path is exercised by tests with a stub adapter.

**Done when:** after an edit run, the card lists the correct files and counts;
Review opens a VS Code diff; Reject and Undo all restore files exactly (CRLF
preserved); checkpoint logic is unit-tested against a temp git repo.

---

## Phase 4: Conversations and history

Reference: `History.dc.html`.

### 4.1 Persist transcripts
- Store each conversation as JSONL under
  `context.storageUri/conversations/<id>.jsonl` (all events), plus
  `index.json` with `{id, title, agents[], costUsd, createdAt, updatedAt, archived, unread}`.
- On webview load, replay the current conversation.
- **New** starts a new conversation instead of wiping the chat.

### 4.2 Conversations panel
The header clock button toggles the panel in the webview:
- Search by title and content.
- Filter chips: All, one per agent, Workflows.
- Groups: Today, Yesterday, This week, Older.
- A blue unread dot on runs that finished while the view was hidden.
- Hover actions: rename, fork (copy the transcript into a new conversation),
  archive. An "Archived (N)" link at the bottom.
- The title defaults to the first prompt, trimmed to 60 characters.

### 4.3 Multi-turn sessions
- Save each agent's session id per conversation: Claude's `session_id` from
  Phase 0.3; Codex's from its JSON output.
- Follow-up messages to the same agent resume the session: `claude --resume <id>`;
  check `codex exec --help` for resume.
- Switching agents mid-conversation starts that agent fresh with a handoff
  preamble: the last reply plus `git diff --stat`.
- Unit-test the argument building.

### 4.4 Handoff context
- **File:** `WorkbenchOrchestrator.handoff` in `src/orchestrator/orchestrator.ts`.
- Build the prompt from the previous agent's final reply (capped at 2000
  characters), the changed-file list from the last `turn.changes`, and the
  original task. Do not use only the original prompt.

**Done when:** reloading VS Code restores the conversation; follow-ups to
Claude continue its session (verified by it remembering an earlier message);
the panel search finds a conversation by a word in its content.

---

## Phase 5: Workflows and compare

Reference: `Workflow.dc.html` and `Compare.dc.html`.

### 5.1 Rename "Plan mode" to "Workflow"
User-facing labels, tooltips, command titles and the `≡` button's title. The
internal `Plan` types may stay. This avoids a clash with the read-only Plan
permission mode.

### 5.2 Workflow stepper
Replace `renderPlanProgress` with the design's vertical stepper:
- **Header:** title, "Workflow · N steps · $cost · time", status chip.
- **Each step:** a status node (done, failed, running, waiting), agent dot and
  name, the step label, per-step time and cost (sum the `cost.update` events
  whose `taskId` starts with that step's `planstep_<id>`), and a one-line
  output link.
- **Between steps:** an italic handoff note describing what was passed on.
- **Failed step card:** the error, then **Retry**, **Retry with ▾** (another
  agent; add `agent?` to `retryPlanStep`/`PlanRunner.retryStep`), **Edit
  prompt** (inline textarea, replacing `window.prompt`), **Skip**.
- **Footer:** Resume/Pause, Abort, Save as template.

### 5.3 Pass context between steps
- **File:** `PlanRunner.executeStep`.
- Prefix each step's prompt with the previous completed step's final reply
  (capped at 2000 characters) and its changed files.
- Record that as the handoff note.

### 5.4 Compare in worktrees
- **Files:** `compareTask` in `src/orchestrator/orchestrator.ts`, a new
  `src/panel/compare-panel.ts`.
- Each side runs in `git worktree add <tmp>/kai-compare-<id>-<side>` (add an
  optional `cwd` override to `AgentRunRequest`).
- Never call `autoApproveDiff` on the main workspace during compare.
- When both finish, open an editor-tab webview matching `Compare.dc.html`: the
  prompt, then two columns (agent, route, time, cost, summary, files with
  counts, test result if the reply reports one) and the actions:
  - **Pick this one:** `git diff` in that worktree, `git apply` onto the main
    tree, then remove both worktrees.
  - **View diff.**
  - **Open worktree:** a new window.
- Remove worktrees on dispose. Put the compare button back in the composer.

**Done when:** a 3-step workflow with a forced failure shows the failed card,
and "Retry with Codex" completes it; compare never modifies the main working
tree until you pick one; worktrees are cleaned up.

---

## Phase 6: Agent protocol upgrades

Larger backend work. Do each as its own session, and start with a short
written spike: findings and a proposed design, then stop for review before
coding.

### 6.1 Real ACP client for Qwen and Gemini
- The current `AcpAgentAdapter` runs `qwen --acp "<prompt>"`, but ACP is
  JSON-RPC over stdio: `initialize`, then `session/new`, then
  `session/prompt`, with `session/update` notifications streaming back and
  `session/request_permission` requests for approvals.
- Check the ACP flag with `qwen --help` and `gemini --help`.
- Implement a JSON-RPC client over the child's stdio and map:
  - `session/update` to text, tool and plan events (plan entries feed the
    Tasks list in `Main.dc.html`);
  - `session/request_permission` to `approval.request`, answered through
    `respondToApproval`;
  - Stop to `session/cancel`.
- Keep one ACP process per conversation so follow-ups reuse the session.

### 6.2 Interactive approvals for Claude
Spike: `claude --help` for `--permission-prompt-tool`, and whether KAI's
`src/cognitive1/mcp-stdio-shim.ts` pattern can host an approval MCP tool that
blocks until the user clicks Allow or Deny.

### 6.3 Memory reaches the agent
- **File:** `runAgent` in `src/orchestrator/orchestrator.ts`.
- Recall results are fetched but never sent. Prepend a bounded briefing
  (max 1500 characters) to the prompt, labelled as context.
- After a run, save a pattern with the task, a reply excerpt (500
  characters) and the changed files via `learn()`.
- Show what was injected in the "Used N memories" chip.

### 6.4 Lock the proxy to KAI
The proxy on `127.0.0.1` accepts requests from any local process or web
page. Require a random per-session token (header `x-kai-token`, written into
the agent configs KAI manages), and reject requests with a browser `Origin`
header.

**Done when:** Qwen streams replies and approvals through KAI; memory
briefings appear in prompts (visible in the chip); the proxy rejects a request
that has no token.

---

## Later: lint cleanup
The lint baseline (356 errors across `src/` and `test/`) comes mostly from `@typescript-eslint`'s
type-aware rules (`no-unsafe-*`, `unbound-method`), largely in tests that mock
VS Code with `any`. Clean it up as its own phase once the upgrade lands, one
directory per session, then make `npm run lint` a hard requirement.

## Out of scope for now
- Moving the chat to VS Code's secondary sidebar. Revisit when the
  `engines.vscode` floor is raised; check that the `secondarySidebar` view
  container is supported first.
- Syntax highlighting inside code blocks.
- Cloud or remote execution.
