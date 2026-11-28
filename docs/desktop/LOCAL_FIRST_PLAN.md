# Local-first KAI: assessment and plan
Written 2026-11-28. Evidence comes from the code on `main` (with uncommitted work) and from the run history KAI saved in
`%APPDATA%\KAI\conversations` (1,351 conversations).

## 1. Goal

Most building work runs on the Mac Studio's models: the Builder, the step-by-step work in Guided Build, Crew builders,
and the small helper jobs. Cloud models are the exception, kept for hard planning, security review, final acceptance, or
a step a local model has failed twice. This has to hold on every surface (Workspace, Studio, Learn & Code, Crew, Lead)
without breaking how KAI works today.

Today local models "can't do the work". The run history shows why, and the main cause is not the models. **KAI's agent
loop was tuned for cloud models and treats a local model's context as if it were free and huge. Then, when it gets
full, it throws away what the model learned.**

## 2. How local runs actually go today (from the saved history)

| Model | Conversations | Typical starting context | What happened |
|---|---|---|---|
| deepseek-flash (cloud) | 1,034 | 31k tokens | median **8.8M input tokens per conversation**: history re-sent every round |
| qwen3-coder-next (LM Studio) | 5 | 41k tokens | 36 in-run compactions, run-limit stops |
| glm-4.5-air (LM Studio) | 2 | 24k | **57 compactions** in one conversation, template errors, "Model unloaded" |
| glm-4.7-flash (LM Studio) | 1 | 23k | "tokens to keep … greater than the context length" ×7, template errors |
| qwen3-coder:30b (Ollama) | 2 | 76k | "did not respond within 90 seconds" ×11 (timeout since raised to 500 s) |

So local models have hardly been used for real work: 5 conversations against more than 1,000 on DeepSeek. The ones
that were tried show the same pattern every time:

- **Re-read loops.** In one conversation `chat/context.ts` was read about **224 times**. In another, about 870
  commands were run and `phase-3-acceptance.md` was read about 63 times. (Counts are halved from the raw events, which
  log each call's start and end.)
- **Compaction thrash.** A single run compacted 30–57 times: fill up → fold → forget → re-read → fill up → fold.
- **Bloated starts.** One Qwen Builder run began with **62k tokens** before its first action. That included 47k of
  preloaded whole files, among them `TimeOffPages.test.jsx`, a mockup `Dashboard.jsx` and two 32 KB verifier scripts,
  plus 8.7k of rules files and 8 near-duplicate "Direction" memories.
- **Server mismatches.** The loaded context was smaller than KAI believed, chat templates failed on KAI's message
  shapes, and models were unloaded mid-run.

## 3. Root causes, ranked by impact

### R1. A fold throws away everything the model read (the main cause)
`compactChatToolHistory` ([direct-provider-runtime.ts:405](../../apps/desktop/src/main/direct-provider-runtime.ts#L405))
turns the run so far into a list of tool calls, each clipped to **200 characters** (`CONTINUATION_TEXT_LIMIT`). No file
contents, conclusions or decisions survive. The model's only option is to read the files again, which fills the window
again, which triggers another fold. The code already knows about this: the Lead branch has a comment saying *"A
200-character tool summary caused Lead to reread it all"*. Only the Lead was fixed, and that fix is to stop
working: it forces a final answer at the first fold.

`foldCanHelp` stops a fold that would not shrink anything. It does not stop a fold that loses everything.

### R2. The starting context is not sized to the model
`buildConversationContext` ([ipc.ts:3186](../../apps/desktop/src/main/ipc.ts#L3186)) preloads **the last 12 files
the conversation ever changed**, whole, up to 32 KB each. It also adds the full Cognitive1 rules (18k characters),
`.kai/ARCHITECT.md`, up to 8 recalled memories with no near-duplicate filtering, the repo map, and the knowledge
briefing. None of this depends on the model's window or on what the current step is about. On a cloud model it costs
money. On a local model it costs the window and minutes of prompt processing (prefill) every round.

### R3. KAI does not know how big the loaded model really is
- The LM Studio preset lists models from the OpenAI-style `/v1/models`, which reports **no context size**.
  `parseModelContexts` already understands `loaded_context_length`, but nothing asks LM Studio's own API
  (`/api/v0/models`), which is where that field comes from.
- Your settings hold three different numbers for the same model: 262,144 reported, 131,072 in your override, and
  whatever LM Studio actually loaded. When the loaded size is the smallest, LM Studio refuses the request ("tokens to
  keep … greater than the context length").
- `compactThresholdFor` then folds at **50% of the window** (`LOCAL_WINDOW_SHARE`). Together with R1, a larger window
  only postpones the thrash.

### R4. Tool output has no cap tied to the model
`run_command` can return **200,000 characters** (`MAX_COMMAND_OUTPUT`, [project-tools.ts:28](../../apps/desktop/src/main/project-tools.ts#L28)),
which is about 50k tokens from one test run. Trimming starts at a fixed 100k characters
([context-trimming.ts](../../apps/desktop/src/main/context-trimming.ts)) for every model. On a local window, one noisy
`npm test` can take the whole budget.

### R5. Local runs are capped at 30 tool rounds
`LOCAL_PROVIDER_MAX_TOOL_ROUNDS = 30` ([direct-provider-runtime.ts:168](../../apps/desktop/src/main/direct-provider-runtime.ts#L168))
ends local runs with "reached a run limit; asking it to sum up". That goes against your own run-limits policy (no
arbitrary caps; a limit asks instead of stopping). Cloud runs get 1,000 rounds.

### R6. Your gateway is treated as paid cloud
`directApi` is `openai-compatible` → `gateway/coding` through a Railway relay. Your context overrides suggest that
relay fronts the Mac, but I am inferring that. KAI decides what is local with `isLocalProvider` (lmstudio, ollama,
llamacpp, vllm only). So the gateway is shown as **"Paid API"** (the Lead header in your screenshot), counts against
spend budgets, and gets none of the local handling. The request also goes out to a public relay and back, which adds
latency and another timeout layer, even when the Mac is on your LAN.

### R7. Models get swapped out mid-run
Roles have been spread over five local models (GLM-4.5-Air, GLM-4.7-Flash, gpt-oss-120b, Qwen3-Coder-Next and
Qwen3-VL). When two large models are wanted at once, LM Studio unloads one ("Model unloaded"). Each swap also costs a
full reload and a cold prompt cache. Nothing in KAI plans which models stay loaded.

### R8. No check that a model handles KAI's message shapes
GLM failed with `Error rendering prompt with jinja template … got ArrayValue`, meaning its chat template could not
render a message KAI sent. Nothing tests a model against KAI's real shapes (tool call, tool result, multi-turn,
image) before a role is given to it. "Test this model" is still an open item in the Guided Build v2 plan.

### R9. History edits defeat the Mac's prompt cache
Processing the prompt (prefill) is the Mac's weak point; generating tokens is not. MLX and llama.cpp reuse the cached
prefix of the previous request. KAI edits old history in place (trimmed tool results, folds), so every trim or fold
forces a full re-read of everything after the edit point. The recalled memories, which change per request, also
sit at the very top of the system message, so a new run never reuses the previous run's cache.

### R10. The helper roles are wired to cloud
The Prompt Guide (Studio, the interview, plan review), the Learning Tutor and the proxy's `qwenConfig` all point at
DeepSeek. Those are the cheapest jobs to move local. Note that **the "qwen" CLI route goes to deepseek-flash**, not
Qwen.

### R11. Repeat detection only catches back-to-back repeats
The guard stops after N identical calls in a row. Reading an unchanged file again after a fold, or reading A, B, A, B,
is never caught.

### R12. Model choice is split across about ten settings
`directApi`, `promptGuide`, `learningTutor`, `proxy`, `agentTeam`, the Model team (in localStorage), the Lead
selection, Crew roles, `autoModel` tiers (CLI only) and Studio each choose a model separately. There is no single
"local first, escalate when needed" rule, so each surface behaves differently.

### R13. Work is not shaped for a local model
Guided Build already enforces one file per step, which is the right instinct. Lead handoffs, Auto and Crew tasks do
not: the Lead in your screenshot handed over a 25-file review. A local model does well with a small step and a check
it can run itself. It does badly with "review everything since commit X".

## 4. Surface by surface

| Surface | Runs on | Local today | Blocking it |
|---|---|---|---|
| **Workspace composer** | `directApi` or a CLI | possible, thrashes | R1–R5, R9 |
| **Lead** | its own target (DeepSeek in your screenshot) | possible | R1 (forced answer at the first fold), R6 label, large handoffs (R13) |
| **Builder / Guided Build** | Model team Builder, local by default | yes, the furthest along | R1, R2, R4; no model check (R8) |
| **Studio** (narrator, brief, plan) | Prompt Guide → DeepSeek | no | R10; structured output not checked on local models |
| **Learn & Code** (tutor) | Learning Tutor → DeepSeek | no | R10; uses `json_schema`, which LM Studio supports, so it is mostly a setting plus a test |
| **Crew** | per role, local-first ladder exists | partly | R7 (2 parallel tasks by default → two models loaded), R1, R12 |
| **Auto / Autopilot** | composer target | possible | R5, R1; plan reviewer is on the Prompt Guide (cloud) |
| **Helpers** (compaction summary, plan review, explore) | mixed | partly | R10 |

## 5. What local-first should look like

### 5.1 A model profile instead of a provider guess
One record per model, measured rather than assumed: **loaded window**, prefill speed, generation speed, whether tool
calls work, whether structured output works, whether it accepts images, and **where it runs** (this machine / my
hardware via gateway / paid cloud). "My hardware" is a flag you set on a gateway, so `gateway/coding` counts as local.

A **"Test this model"** probe fills the profile in about 30 seconds. It sends KAI's real message shapes (tool call →
tool result → follow-up, a JSON-schema reply, a 20k-token prompt for timing) and refuses to assign a role to a model
that fails.

### 5.2 A context budget for every call
Every request is built against the model's real window:

| Part | Share | Notes |
|---|---|---|
| Rules and instructions | ≤ 8% | a **compact rule set** for small windows; full Cognitive1 rules only for cloud and big windows |
| Preloaded project context | ≤ 12% | repo map plus **outlines** of the files named in the step, not whole files |
| Working memory (see 5.3) | ≤ 10% | |
| Run history and tool results | ~50% | |
| Reply reserve | ~20% | |

Tool output is capped per call as a share of the window. For a command, keep the errors, the last 60 lines and the
exit code, and save the full output to a file the model can read if it needs to.

### 5.3 Working memory that survives a fold (fixes R1 and R11)
- **A read ledger.** For each file read this run, record its hash, the line ranges read, and a one-line note.
  Re-reading an unchanged file returns *"unchanged since step 12. Your note: …"* instead of the contents, unless the
  model asks for specific lines.
- **Structured folds.** A fold keeps the plan and its status, files edited (with a summary of the diff), files read
  (with notes), the last check's result, and the next step. The model can also write its own notes to the step file
  (`.kai/steps/<conv>.md` already exists and is mentioned after a fold, but nothing makes the model keep it).
- **Fold late, fold once.** Trigger at about 75% of the *loaded* window, not 50%, and only fold when the working
  memory is in place.

### 5.4 Keep the Mac's prompt cache warm (fixes R9)
- **Stable prefix.** Rules, then tools, then the project map go first and stay identical between runs. Content that
  changes (memories, history notes, the step) goes after them.
- **Append-only within a run.** Old messages are not edited in place. Space is reclaimed only at a fold, which
  becomes a deliberate, rare event.

### 5.5 One routing policy for every surface (fixes R12 and R10)
One setting, **Local first**, with one table that every surface reads:

| Job | Default | Escalate to cloud when |
|---|---|---|
| Builder step, edit, test fix | local coder (Qwen3-Coder-Next) | the same step fails its check twice, or the person asks |
| Helpers: summaries, titles, narrator, tutor, interview, explore | small local model | never automatically |
| Lead discussion | local big model (gpt-oss-120b or the coder) | the person picks cloud, or the task is marked heavy |
| Plan for a large feature, architecture | cloud | — |
| Security review, final accept | cloud | — |
| First-pass code review | local | the local review finds a risk |

The existing pieces (Crew's `localFirst` / `escalateAfter` ladder, the Guided Build "retry with the Coach's model",
`autoModel` tiers) become this one policy instead of three.

### 5.6 Work shaped for a local model (fixes R13)
Before a task goes to a local Builder, it is cut into steps that each name at most a few files and carry a check. The
Lead's handoff becomes a step list. The Guided Build engine already does this, so Lead, Auto and Crew should use it
too. "Review all 25 changed paths" becomes 25 small checks run by a script, with the model looking only at the
failures.

### 5.7 Decide which models stay loaded (fixes R7)
KAI plans a **resident set**: one main coder plus one small helper model, kept loaded. Roles are mapped onto that set
rather than onto whatever model was last chosen. Crew's `maxParallelTasks` defaults to 1 for local targets unless the
profile shows the server handles parallel requests.

## 6. Phased plan that keeps today's build working

Each phase is releasable on its own. Cloud behaviour stays as it is unless a model is marked local.

**Phase A: quick wins (small, low risk)**
1. Replace the 30-round local cap with the same ask-to-continue behaviour cloud runs get (R5).
2. Cap tool output by window share: errors, tail and exit code, with the full output saved to a file (R4).
3. Read the loaded window from LM Studio's `/api/v0/models` (and Ollama's `/api/show`) and show it next to the
   override. Warn when the override is bigger than what is loaded (R3).
4. Add a "This gateway is my own hardware" flag: no cost estimate, a "Local" label, and local handling (R6).
5. Preload only the files the step names, as outlines; drop "last 12 changed files" for windows under 200k (R2).
6. Remove near-duplicate memories before they are injected (the 8 "Direction:" memories).

**Phase B: a loop that can finish (the big one)**
1. Read ledger plus a guard against re-reading unchanged files (R1, R11).
2. Structured fold with working memory, triggered at 75% of the loaded window (R1, R3).
3. Stable prefix and append-only history; memories move out of the top of the system message (R9).
4. A compact rule set for local and small-window runs.
5. Tests: replay the saved Qwen conversation shapes and assert that re-reads and folds stay under thresholds.

**Phase C: model profiles and routing**
1. Model profile store, the "Test this model" probe, and a gate on role assignment (R8).
2. One Local-first routing policy read by every surface, mapped onto the existing Crew ladder (R12).
3. Move the helper roles (Prompt Guide, Tutor, compaction summary, plan review) to the small local model, with their
   structured outputs checked by the probe (R10).
4. Resident-set planner and local-aware Crew parallelism (R7).

**Phase D: work shaping and escalation**
1. Lead handoff → step list through the Guided Build engine (R13).
2. Escalation rule: after two failed checks on a step, retry once on the cloud model, then hand back to local.
3. A local first-pass reviewer, so cloud only sees diffs that were already flagged.

**Phase E: measure it**
Score every run with: re-reads, folds, prefill tokens per round, time per step, finished without cloud (yes/no) and
check pass rate. Run the existing evals with local models and track the share of steps finished locally. That share
is the number that says whether the Mac is paying off.

**Rollout order:** Workspace Builder → Learn & Code → Studio → Crew → Lead. This follows the Guided Build v2 order, and
the Builder benefits most from Phases A and B.

## 7. Mac Studio side (settings to check, not verified from here)
- Load Qwen3-Coder-Next with an explicit context length (128k is a sensible start), and make KAI's override match
  what is loaded.
- Turn off auto-unload and idle eviction for the resident models.
- Keep to two resident models; drop GLM-4.5-Air and GLM-4.7-Flash from roles until they pass the template probe.
- ~~Point KAI at LM Studio's LAN address~~ Superseded: KAI connects to the gateway (port 8000) at home and to the
  Railway relay away, never to LM Studio's port 1234 (see 7c).
- Consider an 8-bit KV cache if memory is tight with a long window.

## 7b. Gateway task routing (recommended 2026-11-28)
The gateway already queues requests so a model is not unloaded mid-response. Routing should keep **only two chat models
loaded** (Qwen3-Coder-Next and Gemma-4-26B), and no fallback should load a third.

| Route | Primary | Fallback | Gateway web search |
|---|---|---|---|
| Coding | Qwen3-Coder-Next | none: a failure should surface so KAI can escalate | **off**: KAI's agents have their own `web_search` tool |
| Research | Gemma-4-26B | Qwen3-Coder-Next (already loaded) | on |
| General chat | Gemma-4-26B | Qwen3-Coder-Next | off |
| Image questions | Gemma-4-26B | none | off |
| Image generation | z-image-turbo | none | — |

What KAI should call:
- Builder, Lead and Auto → `gateway/coding`
- Prompt Guide, Tutor, summaries and titles → `gateway/general`
- design screenshots → `gateway/vision`

The proxy's qwen route should move off deepseek-flash. KAI's window overrides for the Gemma aliases (60,000 today)
should match what LM Studio actually loads.

## 7c. Mac setup as done (reported by Claude on the Mac, 2026-11-28)
- GPU memory limit is 118,000 MB and reapplied at boot.
- **The gateway sets the context length when it loads a model, overriding LM Studio.** Coder (4-bit): 131,072.
  Gemma: 65,536. Both are pinned against idle unload. Large image or video jobs can still push them out; they reload
  on the next request. Confirmed active (second report, 2026-11-28).
- LM Studio itself (port 1234) is **not** on the network, on purpose. **KAI connects only to the gateway**, which
  handles keys and memory protection.
- Mac sleep: still to be turned off by the user.

**How KAI connects**
| Where | Address |
|---|---|
| Home | `http://<mac-name>.local:8000/v1` (fallback `http://192.168.68.52:8000/v1`; this IP can change) |
| Away | the existing Railway relay |

- The same gateway key works for both.
- Models: `gateway/coding` for coding and `gateway/general` / `gateway/vision` for helpers. **Never `gateway/auto`**:
  it returns HTTP 409 when a request matches more than one task type.
- **A queued request is not a failure.** A long video job can keep chat requests waiting, so a slow first byte has
  to show "Waiting: the Mac is busy" and keep waiting, not count as a provider failure.

**Test from this PC (2026-11-28)**
- `GET http://192.168.68.52:8000/` → 200 in 10 ms.
- `GET /v1/models` without a key → **401 "Authentication credentials were not provided"**. That is expected: the
  gateway is up and asks for its key. The keyed test is still to do.
- The first try timed out after 8 s, and a retry answered in 13 ms.
- LAN ping was 87–117 ms with a VPN active. A LAN ping should be a few ms, so the VPN may be
  getting in the way of local traffic. Turning on the VPN's local-network access should fix both.
- `<mac-name>.local` **does not resolve on this Windows PC**: `.local` (mDNS) names are not reliable on Windows,
  especially behind a VPN. Use the IP, and ideally give the Mac a fixed IP in the router.

**Corrections from the Mac (second report, checked there against the gateway's code and logs)**
- `gateway/*` entries in `/v1/models` carry **no** `context_length`.
- `gateway/coding` **still falls back to `lmstudio/qwen3.8-27b-mlx`, loaded at 65,536**. So 131,072 is only safe
  when the Coder serves the request.
- A queued chat request gets **no headers or bytes until it starts**, and can queue for up to **3 hours** (about 14
  minutes seen behind a video). Silence is not a dead connection.
- Home only: send a unique `gateway_request_id` in the request body and poll
  `GET /api/routing/requests/<id>/` (status, detail, position). `GET /api/routing/queue/` gives the active job and
  queue length. Both are at the **server root**, not under `/v1`, and use the same key.
- Away: the relay does not forward those routes and **gives up after 600 s** without response headers. Treat that as
  "possibly busy".
- **503** can mean the Mac is short of memory for a while (seen just after a video). Show the message, retry later.
- **429 `model_queue_full`**: too many requests waiting; the limit is 8 per user.

**What KAI does with these today** (read from `direct-provider-runtime.ts`)
- No custom HTTP dispatcher is set, so Node's `fetch` default of about **300 s** for response headers likely cuts in
  before KAI's own 500 s timer (not measured yet). The same default applies to silence inside a stream.
- That cut surfaces as "fetch failed", which `fetchWithHeaderTimeout` treats as a dropped connection and sends again
  (3 tries), inside a request loop that also tries 3 times. One queued request can become **up to 9 sends** over about
  45 minutes, then fail. If the gateway keeps abandoned requests queued, that alone passes the limit of 8.
- 503 and 429 are retried 3 times with waits of about 0.5 s and 1 s (longer only with `Retry-After`, capped at 30 s):
  far too short for a memory shortage or a full queue.

**KAI work this adds (into Phase A)**
- A1+: **connection profiles for one gateway**: Home and Away addresses with the same key. KAI tries Home first
  (with a quick health check) and falls back to Away. The address used is shown on the run's first line.
- A2+: **queue-aware waiting** for my-hardware gateways only:
  - raise the transport's header and body timeouts to 3 hours or more for these requests;
  - never resend a request just because it has been silent;
  - Home: send `gateway_request_id`, poll status, show "Waiting for the Mac: position N". Stop only if the gateway
    says the request failed or is unknown, the status route stops answering, or the person cancels;
  - Away: on the relay's 600 s cut, say "the Mac may be busy" and offer Retry or Go to Home; no automatic resends,
    since the status cannot be checked.
- A3+: **refuse `gateway/auto`** as a role model and offer the specific route instead. Point the KAI aliases still set
  to `gateway/auto` at their specific routes.
- A4+: **context sizes are set in KAI**, since the gateway does not report them: Gemma routes 65,536;
  `gateway/coding` **65,536 while it has the 27B fallback**, 131,072 once the fallback is removed in the gateway's
  Task routing (recommended in 7b). Requesting the Coder by its `lmstudio/…` id also gives 131,072, with no
  fallback to rely on.
- A7: **gateway errors get their own handling**: 503 shows the message and retries over minutes (30 s, 60 s, 120 s,
  then asks); 429 `model_queue_full` waits for the queue to drain and does not hammer it. Run doctor gets a named
  cause for each.
- Tests: a fake gateway that delays headers past 300 s (with fake timers or a short injected timeout), returns 503 and
  `model_queue_full`, and counts the sends: exactly one for a queued request.

## 7d. Which fixes reach which feature (checked 2026-11-28)
KAI reaches a model three ways, and a fix only helps the path it is made on.

| Path | Used by | Gets |
|---|---|---|
| **Agent loop** (`direct-provider-runtime.ts`), runs set to API | Workspace, Builder / Guided Build, Lead, and Auto, Autopilot, Architect, Crew roles when set to API | A and B in full |
| **Helper requester** (`learning-tutor.ts`, with its own HTTP calls) | Learn tutor, Prompt Guide, Interview, Studio documents, plan review | routing, model checks, and **its own copy of A2 and A7** (queue waiting, 503/429) and context sizing |
| **CLI agents** (Claude Code, Codex, Qwen Code and others) | any surface or role set to CLI, including workflow steps that run that way | none of the loop fixes: the CLI manages its own context |

- A2 and A7 must be built once and shared by both HTTP paths, or Studio and Learn will still fail on a busy Mac.
- Local-first (Phase C) should therefore default local roles to **API** execution, and say so when a local role is
  set to a CLI.

## 8. Decisions (answered 2026-11-28)
1. **`gateway/coding` on the Railway relay is the Mac.** Phase A4 goes ahead: the gateway is marked as your own hardware.
2. **128 GB unified memory, 115 GB budget for models.** That budget has to hold the model weights and their context
   caches together. Sizes below are approximate and should be confirmed in LM Studio:
   - **Resident main model:** Qwen3-Coder-Next. About 45 GB at 4-bit, about 60 GB at 6-bit. Most of its layers use
     linear attention, so its context cache stays small, and a 128k window is realistic.
   - **Resident small helper:** one model around 15–20 GB (for example Gemma-4-26B-A4B or Qwen3.8-27B at 4-bit) for
     titles, summaries, the narrator, the tutor and explore.
   - **Not resident:** gpt-oss-120b (about 63 GB). It does not fit next to the coder within 115 GB with a long
     context, so it loads only on request, never as a default role.
   - Crew runs one local task at a time unless the profile shows the server handles two without swapping.
3. **The Lead runs locally by default, with the existing switches kept for cloud help.** The local Lead uses the
   resident Qwen3-Coder-Next, so Lead and Builder share one loaded model and nothing swaps. A local Lead needs the
   Phase B fold fix first, because today the Lead stops and answers at its first fold. The cloud switches stay exactly
   as they are. Phase D adds one more thing: when a local Lead plan touches security or architecture, it suggests
   (never forces) a cloud review.

## 9. Work split: Claude and Codex (2026-11-28)

Both agents work in the same tree. These task IDs replace the phase item numbers above.

### 9.1 Ownership
| Owner | Files |
|---|---|
| **Claude** (engine) | `main/direct-provider-runtime.ts`, `main/context-trimming.ts`, `main/context-builder.ts`, `main/project-tools.ts`, `main/run-guard.ts`, `main/execution-rules.ts`, new `main/model-transport.ts` and working-memory modules, `contracts/src/usage.ts`; in `main/ipc.ts` only run start, context building and compaction |
| **Codex** (product) | all of `renderer/`, all other contracts (including new `model-host.ts`), `main/learning-tutor.ts`, `main/prompt-guide.ts`, `main/interview.ts`, `main/studio.ts`, `main/provider-models.ts`, `main/run-doctor.ts`, `main/crew-*.ts`, new `main/gateway-address.ts` and `main/model-probe.ts`; in `main/ipc.ts` only new handlers and the provider and settings handlers |

(`main/` and `renderer/` are under `apps/desktop/src/`; `contracts/` is under `packages/`.)

- A change needed in the other agent's file is written under 9.4, not made.
- `main/ipc.ts` is shared: re-read it before each edit and keep edits inside your own areas.

### 9.2 Shared interfaces (change only by writing it under 9.4)
```ts
// packages/contracts/src/model-host.ts  (Codex, first task)
export type ModelHost = 'this-computer' | 'own-hardware' | 'cloud';
export function modelHostOf(
  connection: Pick<ApiConnection, 'provider' | 'baseUrl'>,
  settings: AppSettings,
): ModelHost;

// apps/desktop/src/main/gateway-address.ts  (Codex, first task)
export interface GatewayAddress {
  baseUrl: string;            // ends in /v1
  label: 'home' | 'away' | 'direct';
  statusRoot?: string;        // server root; set only when the status routes work (home)
}
export function resolveGatewayAddress(
  connection: ApiConnection, settings: AppSettings, apiKey?: string,
): Promise<GatewayAddress>;

// apps/desktop/src/main/model-transport.ts  (Claude, first task)
export interface ModelWaitStatus {
  state: 'queued' | 'running' | 'busy' | 'queue-full';
  position?: number;
  detail?: string;
}
export function modelFetch(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  options: {
    host: ModelHost; statusRoot?: string; apiKey?: string;
    onStatus?: (status: ModelWaitStatus) => void;
  },
): Promise<Response>;
```
`modelFetch` owns timeouts, queue waiting, `gateway_request_id`, 503 and 429 handling and resend rules. Callers do
not add their own retry loop around it for those cases.

### 9.3 Rounds
A round ends when both lists are done, `npm run desktop:typecheck` is clean, the touched tests pass, and each agent
has reviewed the other's diff.

| Round | Claude | Codex |
|---|---|---|
| **1 (Phase A)** | K1 `model-transport.ts` (queue waiting, 503/429, one send per queued request) and the agent loop using it · K2 remove the 30-round local cap · K3 tool output capped by window share · K4 preload only named files, as outlines · K5 merge near-duplicate memories · K6 no cost or budget charge for own-hardware runs | X1 `model-host.ts` and the "my own hardware" switch and labels · X2 Home/Away addresses (`gateway-address.ts`) · X3 context sizes (gateway defaults 65,536 / 131,072 rules, LM Studio `/api/v0/models`) · X4 refuse `gateway/auto` · X5 helpers default to gateway routes and use `modelFetch` (after K1) · X6 Run doctor causes for queued, 503, queue full |
| **2 (B + C)** | K7 read ledger and re-read guard · K8 structured fold with working memory, at 75% of the window · K9 stable prefix, append-only history · K10 compact rule set for local runs · K11 replay tests from the saved Qwen runs | X7 "Test this model" probe and role gate · X8 one Local-first routing policy used by every surface, defaulting local roles to API · X9 helpers on the small model · X10 resident set and one local Crew task at a time |
| **3 (D + E)** | K12 escalation policy (two failed checks → one cloud retry) as a pure module · K13 per-run measures: re-reads, folds, wait time, finished locally, check passed | X11 Lead hands over step lists through the Guided Build engine · X12 wire K12 into Guided Build, Crew and Auto controls · X13 local first-pass review · X14 show K13 measures |

### 9.4 Handoff notes
Append dated, one-line notes here: what you delivered, what you need from the other agent, interface changes.

2026-11-28 — Baseline before Codex edits: `npm run desktop:typecheck` passed; existing provider/runtime tests passed (72/72); no pre-existing failures observed.
2026-11-28 — X1 progress: added `model-host.ts` (`ModelHost`/`modelHostOf`) and persisted the “This gateway is my own hardware” Settings switch; targeted tests and typecheck passed (52 targeted tests); superseded by the K1/K6 integration note below.
2026-11-28 — X2 progress: added tested Home-first resolver with 1.5 s health check, Away fallback and selected address/status root; superseded by the K1 integration and security-hardening note below.
2026-11-28 — X3: `modelContextFor` now supplies gateway route windows (coding 65,536 with current fallback; helper routes 65,536), and LM Studio refresh reads `/api/v0/models` loaded context; typecheck and targeted provider/context tests passed; 131,072 coding mode was not verified because the current gateway fallback is still configured.
2026-11-28 — X4 progress: own-hardware model catalog and settings reject/hide `gateway/auto` and list specific routes; superseded by K1 request-time rejection noted below.
2026-11-28 — X5 pending K1 at handoff: helper transport was deferred until `modelFetch` existed; completed after K1 as noted below.
2026-11-28 — X6 progress: Run Doctor names queued Mac, 503 memory and 429 `model_queue_full` causes; final K1 integration verification is recorded below.
2026-11-28 — Shared-interface progress: no Codex interface changes proposed; K1 now uses `resolveGatewayAddress` and `modelHostOf`, surfaces the selected address, and rejects `gateway/auto`; X5 and X6 completion are noted below.

2026-11-28 — Claude K1 delivered: `model-transport.ts` (`modelFetch`, `ModelHostError`, additive `timing` option for tests); the agent loop resolves home/away, shows the address, rejects `gateway/auto`, and adds no retries of its own after a `ModelHostError`. Not verified against the real gateway or past a real 300 s wait. A 503 now ends the run with a "send continue" message after 30/60/120 s waits (it does not open an Ask question).
2026-11-28 — Claude K2–K6 delivered: no 30-round default for local runs; tool results capped at 8% of the window (`tool-output-cap.ts`, full output in `.kai/outputs/`); own-model runs preload only named files and outline long ones; near-duplicate memories merged; own-hardware runs cost 0 and skip the budget block.
2026-11-28 — For Codex (review of X2, please fix): `resolveGatewayAddress` sends the API key over plain HTTP to a hardcoded `192.168.68.52` whenever anything there answers 200/401, so on another network a different device would receive the key and project code. It also redirects every `openai-compatible` connection, including a role's other cloud gateway and its key, to the Mac. Make the home address a setting (empty by default), health-check without `Authorization`, verify the reply is the gateway, and apply it only to the connection marked as own hardware.
2026-11-28 — For Codex: `crew-runner.ts` and `architect-loop.ts` still pass `toolRoundLimit: 30` for local builders (K2 removed only the loop's default); decide in X10. X3 edited `contracts/src/usage.ts`, which 9.1 gives to Claude: accepted, but note it here first next time.
2026-11-28 — Claude: fixed K6/K4 so a cloud provider reached through a localhost relay keeps its cost, budget and full context. Added the K11 replay test (`test/desktop-local-replay.test.ts`, scripted model): baseline on a 12,000-token window is 19 reads where 10 are needed (9 re-reads, 3 folds); with a roomy window, 10 reads and 0 folds.
2026-11-28 — Claude test run: full desktop set 2,860 passed, 9 failed, 4 skipped. Rerun of the failing files at 14:05: 64 passed, 1 failed; both typechecks clean. For Codex: `test/desktop-settings-groups.test.ts` still expects the settings list without `gatewayHomeUrl` and `gatewayOwnHardware`; update the expectation if both belong in that group.
2026-11-28 — Codex Round 1 delivery/review: X2 now uses the optional Home URL setting, unauthenticated gateway-specific health checks, and own-hardware-only routing; X5 helper calls use `modelFetch` with gateway/general and image gateway/vision; X6 Run Doctor handles queue, 503 memory and 429 queue-full. Typecheck passed; focused product tests passed 76/76; `npm run desktop:test` had 3,204 passed, 4 skipped and one `desktop-lead-model-selector-rendered` hook timeout, whose isolated rerun passed 12/12. Review findings for Claude to address: `model-transport.ts:418` continues forever on status `unknown` or repeated 404 before any known record (until the 4-hour headers timeout); `model-transport.ts:127-140` throws after the first local reconnect delay instead of retrying; `direct-provider-runtime.ts:3654-3669` retains a 500-second body-idle timeout, below the planned 3-hour-or-more own-hardware wait. No duplicate resend found for queued own-hardware requests; cancellation is wired through the request and status poll; the API key is not sent by health checks and is only sent to model/status endpoints at the selected gateway. No cloud/CLI regression was observed, but real gateway behavior and waits beyond the test timings were not verified. Claude's `modelFetch` `timing` test option is additive to the 9.2 interface and is now noted here; no Codex interface change proposed. X10 crew round-limit decision remains for Round 2.
2026-11-28 — Claude, on Codex's three findings: (1) fixed: an unrecorded or unrecognised status is now shown to the person; KAI keeps waiting and never resends. (2) not a bug: a new test drops a this-computer request twice and the third try succeeds. (3) fixed: 30 minutes of mid-reply silence allowed for own-hardware and this-computer runs; cloud stays at 500 s.
2026-11-28 — Claude review of Codex X1–X6, for Codex to fix:
(R1, high) `learning-tutor.ts` passes `AbortSignal.timeout(requestTimeoutMs = 120 s)` into every `modelFetch`, so a helper queued on the Mac is aborted after 2 minutes. For own hardware, do not time the wait (keep only the person's cancel signal); keep 120 s for cloud. Also pass `onStatus` or surface "waiting for the Mac". Add a test with a delayed reply.
(R2, high) `model-host.ts` ties ownership to `settings.directApi.provider === 'openai-compatible'`. Switching the default API to DeepSeek makes the Mac gateway count as cloud for every role and helper (no queue waiting, budget charges, "Paid API"). Store the owned gateway's address with the flag and match connections against it, independent of the current default. `settings.directApi` fields used by `resolveGatewayAddress` need the same change.
(R3, high) `run-doctor.ts` matches bare `503`, `queued` and `out of memory` against all evidence, including tool stdout, and runs these rules first: a test log with "line 503" or any cloud 503 is diagnosed as the Mac being short of memory, and a run that merely waited in the queue is blamed on the queue. Match only the transport's own error sentences in `input.error`.
(R4, check) Saved helper settings still point at DeepSeek; only choosing the gateway preset selects `gateway/general`. Either offer a one-click "move helpers to my hardware" or say so in Settings.
2026-11-28 — Codex follow-up: R1 helper requests now bypass the 120 s timeout only for own hardware, keep caller cancellation and surface queue status; delayed own-hardware (75 ms vs 20 ms test timeout) and cloud-timeout tests pass. R2 gateway profiles and Local labeling are independent of DeepSeek defaults; role/profile/address and Local classification tests pass. R3 diagnoses only transport sentences in `input.error`; test with unrelated tool output containing “503” and “queued” passes. R4 handled with Settings instructions to select OpenAI-compatible + `gateway/general` per helper. Review: no duplicate send found while an own-hardware request is confirmed queued; cancel signal reaches the model request/status poll; health checks are unauthenticated and the key is sent only to the selected gateway's model/status endpoints; cloud request timeout/retry path and CLI path remain unchanged by inspection. Claude request: `direct-provider-runtime.ts` resolves a role missing `baseUrl` to the OpenAI preset before `routeModel` classifies it, so with DeepSeek as default that role may miss the saved gateway URL and be treated as cloud; fill missing own-gateway URL/credential from the saved profile before resolving, and add a runtime regression test. `npm run desktop:typecheck` passed; focused tests passed 191/191; full `npm run desktop:test`: 3,212 passed, 4 skipped, 1 failed (MCP reconnect test exceeded 5 s), then that file passed 8/8 alone. No live gateway, real 3-hour wait, or real key transmission was exercised; no other review finding observed.
2026-11-28 — Claude: done, the missing-baseUrl role case (`withGatewayProfile` in `api-connection.ts`, used by the loop and run start, with a runtime test). Also changed two Codex files while Codex was stopped: `settings:update` in `ipc.ts` overwrote the saved Away address with any OpenAI-compatible default (marking a third party's service as own hardware, free and unbudgeted), so it now fills only an empty profile; `model-host.ts` and `guided-build-engine.ts` count the default's address as owned only while no Away address is saved.
