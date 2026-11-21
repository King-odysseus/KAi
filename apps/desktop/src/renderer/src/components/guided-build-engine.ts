import { ARCHITECT_STUCK_SENTINEL, LOCAL_PROVIDERS, directProviderPreset, isLocalProvider, type AppSettings, type GuidedBuild, type GuidedBuildStep, type RoleTarget } from '@kai/contracts';
import { guidedBuildText, parseGuidedBuildObject } from './guided-build-format';

/**
 * The one place Guided Build's rules live: the prompts, how a plan is read and cleaned, and which chat turns belong to
 * it. Workspace and Learn & Code both used to carry their own copies, with different wording, so a plan made in one was
 * parsed and worded differently from the other. Both now call this, and a rule is fixed once.
 *
 * Nothing here touches React, the disk or a model, so it can be tested directly.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Who builds by default
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The model that builds when the person has not picked one: a model on this computer or the home network, because the
 * point of Guided Build is to keep a strong, paid model for planning and review. The server in Settings' direct API is
 * used when it is local; otherwise the first local server KAI has models remembered for. Null when none is set up, and
 * the Builder then falls back to the agent in use. The person can pin the Builder to anything, cloud included.
 */
export function defaultLocalBuilder(settings: Pick<AppSettings, 'directApi' | 'savedLocalModels'>): RoleTarget | null {
  const direct = settings.directApi;
  if (LOCAL_PROVIDERS.has(direct.provider)) {
    const preset = directProviderPreset(direct.provider);
    return {
      execution: 'api',
      api: {
        provider: direct.provider,
        ...(direct.baseUrl && direct.baseUrl !== preset.defaultBaseUrl ? { baseUrl: direct.baseUrl } : {}),
        ...(direct.credentialId && direct.credentialId !== preset.credentialId ? { credentialId: direct.credentialId } : {}),
        ...(direct.model.trim() ? { model: direct.model.trim() } : {}),
      },
    };
  }
  for (const provider of LOCAL_PROVIDERS) {
    const model = settings.savedLocalModels[provider]?.[0];
    if (model) return { execution: 'api', api: { provider, model } };
  }
  return null;
}

/** Who a role is, as a person reads it, and whether it runs on this computer or the home network. */
export function describeRole(target: RoleTarget | null | undefined, agentNames: Readonly<Record<string, string>> = {}): { label: string; local: boolean } {
  if (!target) return { label: 'the agent in use', local: false };
  if (target.execution === 'cli') {
    const name = agentNames[target.agent ?? ''] ?? target.agent ?? 'agent';
    return { label: target.model ? `${name} · ${target.model}` : name, local: false };
  }
  const api = target.api;
  if (!api) return { label: 'API', local: false };
  const preset = directProviderPreset(api.provider);
  const model = api.model ?? preset.defaultModel ?? '';
  const local = isLocalProvider(api.provider);
  // Never the provider's name twice: with no model known the label is just the provider, not "Gateway · Gateway".
  const label = local ? `${model || preset.displayName} (on this computer)` : model && model !== preset.displayName ? `${model} · ${preset.displayName}` : preset.displayName;
  return { label, local };
}

/**
 * A target with the model KAI will really use filled in. Choosing a provider from a menu gives a target with no model, and
 * the run then uses the model saved in Settings (the direct API's, or the first remembered for that server), so the label
 * and the request should say so instead of showing nothing.
 */
export function withSettingsModel(target: RoleTarget, settings: Pick<AppSettings, 'directApi' | 'savedLocalModels'>): RoleTarget {
  if (target.execution !== 'api' || !target.api || target.api.model) return target;
  const { provider } = target.api;
  const direct = settings.directApi.provider === provider ? settings.directApi.model.trim() : '';
  const model = direct || settings.savedLocalModels[provider]?.[0] || '';
  return model ? { ...target, api: { ...target.api, model } } : target;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chat labels
// ---------------------------------------------------------------------------------------------------------------------

/** The short line the chat shows for a Guided Build request, instead of the long prompt that was really sent. */
export const GUIDED_LABELS = [
  'Create my coding plan',
  'Create a coding plan',
  'Add an idea to my plan',
  'Ask the Coach',
  'Check this edit',
  'Check my changes',
  'Show me the code to type',
  'Write this change in the file',
  'Builder: implement this step',
  'Builder task',
] as const;

const GUIDED_LABEL_SET: ReadonlySet<string> = new Set(GUIDED_LABELS);

/** True when a user turn's text is one of Guided Build's own requests, so its answer belongs in the guided chat. */
export function isGuidedLabel(text: string): boolean {
  const label = text.trim();
  return GUIDED_LABEL_SET.has(label) || label.startsWith('Coach: ') || label.startsWith('Builder: ');
}

/** The turns that belong to Guided Build: each guided request and the replies that follow it, nothing else. */
export function guidedTurnIndexes(turns: ReadonlyArray<{ role: string; text: string }>): Set<number> {
  const indexes = new Set<number>();
  let inside = false;
  turns.forEach((turn, index) => {
    if (turn.role === 'user') inside = isGuidedLabel(turn.text);
    if (inside) indexes.add(index);
  });
  return indexes;
}

/** A conversation's title from the person's own words, never from the instructions KAI wrapped around them. */
export function guidedTitle(displayText: string | undefined, prompt: string): string {
  const shown = (displayText ?? '').replace(/^(Coach|Builder):\s*/i, '').trim();
  return (shown || prompt).replace(/\s+/g, ' ').trim().slice(0, 64);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------------------------------------------------

const EXTENSIONS = 'mdx|md|jsonc|json|jsx|js|mjs|cjs|tsx|ts|css|scss|html|yaml|yml|toml|lock|py|rs|go|java|kt|sh|ps1|txt|sql|vue|svelte';
/** A file name that runs straight into the next one: `README.mdpackage.json`. */
const GLUED = new RegExp(`(\\.(?:${EXTENSIONS}))(?=[A-Za-z_@][\\w@./-]*\\.(?:${EXTENSIONS})\\b)`, 'gi');
const PATH_TOKEN = new RegExp(`[\\w@.\\\\/-]*[\\w-]\\.(?:${EXTENSIONS})\\b(?::\\d+)?`, 'gi');

export interface PlanLocation {
  /** One project-relative file, with a line when one was given: `src/App.tsx` or `src/App.tsx:42`. */
  where: string;
  /** Any other files the step named. They belong in the instructions, not in the one place a step opens. */
  related: string[];
}

/** One file and the others. A model often gives a list, or glues two names together; the panel opens exactly one. */
export function planLocation(raw: string): PlanLocation {
  const spaced = raw.replace(GLUED, '$1 ').replace(/\\/g, '/');
  const found = [...new Set((spaced.match(PATH_TOKEN) ?? []).map((item) => item.replace(/^\.\//, '')))];
  if (found.length === 0) return { where: raw.trim(), related: [] };
  const line = /(?:line\s*|#L|:)(\d{1,6})\b/i.exec(spaced.slice(spaced.indexOf(found[0]!) + found[0]!.length))?.[1];
  const first = found[0]!;
  const primary = /:\d+$/.test(first) || !line ? first : `${first}:${line}`;
  return { where: primary, related: found.slice(1).map((item) => item.replace(/:\d+$/, '')) };
}

const READ_ONLY_TITLE = /^(?:read|review|study|understand|explore|learn|tour|map|survey|look(?:\s+at)?|inspect|familiari[sz]e|get to know|start with the)\b/i;
const EDIT_WORD = /\b(?:add|change|create|edit|update|write|replace|remove|rename|insert|fix|implement|delete|move|wire|set|apply|extract|convert|install)\b/i;

/** A step that only reads or tours the code. Guided Build steps each make one change: reading is the Coach's job. */
export function isReadOnlyStep(step: Pick<GuidedBuildStep, 'title' | 'instructions' | 'code'>): boolean {
  if (step.code && step.code.trim()) return false;
  return READ_ONLY_TITLE.test(step.title.trim()) && !EDIT_WORD.test(step.instructions);
}

export interface ReadPlan {
  title: string;
  steps: GuidedBuildStep[];
  /** Steps left out because they only read, so the Coach can say so rather than the plan silently shrinking. */
  droppedReadOnly: string[];
}

/** A plan from the Coach's reply, cleaned: one file per step, no step that changes nothing, the first one active. */
export function readGuidedPlan(text: string, makeId: (index: number) => string = (index) => `step-${index + 1}`): ReadPlan | null {
  const parsed = parseGuidedBuildObject(text) as { title?: unknown; steps?: unknown } | null;
  if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.steps)) return null;
  const all: GuidedBuildStep[] = [];
  parsed.steps.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const value = raw as Record<string, unknown>;
    if (typeof value.title !== 'string' || !value.title.trim()) return;
    const location = planLocation(guidedBuildText(value.where));
    const instructions = guidedBuildText(value.instructions);
    all.push({
      id: typeof value.id === 'string' && value.id ? value.id : makeId(index),
      title: value.title.trim(),
      why: typeof value.why === 'string' ? value.why : '',
      where: location.where,
      instructions: location.related.length ? `${instructions}\n\nRelated files: ${location.related.join(', ')}.`.trim() : instructions,
      ...(typeof value.code === 'string' && value.code ? { code: value.code } : {}),
      acceptanceCriteria: Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [],
      status: 'pending',
      ...(typeof value.needsApproval === 'string' && value.needsApproval.trim() ? { needsApproval: value.needsApproval.trim() } : {}),
    });
  });
  const editing = all.filter((step) => !isReadOnlyStep(step));
  // A plan made only of reading steps is kept whole: an odd plan is better than none, and the person can still edit it.
  const steps = (editing.length > 0 ? editing : all).map((step, index): GuidedBuildStep => ({ ...step, status: index === 0 ? 'active' : 'pending' }));
  return {
    title: parsed.title.trim(),
    steps,
    droppedReadOnly: editing.length > 0 ? all.filter((step) => isReadOnlyStep(step)).map((step) => step.title) : [],
  };
}

export type GuidedReviewStatus = 'ready' | 'changes-needed' | 'unverified';

/** The Coach's check of a step. Null when the reply is not a review, so the prose stays visible instead. */
export function readGuidedReview(text: string): { status: GuidedReviewStatus; summary: string } | null {
  const parsed = parseGuidedBuildObject(text);
  if (!parsed || typeof parsed.summary !== 'string') return null;
  const status = String(parsed.status);
  if (status !== 'ready' && status !== 'changes-needed' && status !== 'unverified') return null;
  return { status, summary: parsed.summary };
}

// ---------------------------------------------------------------------------------------------------------------------
// Evidence: what KAI itself ran
// ---------------------------------------------------------------------------------------------------------------------

/** The result of a project check KAI ran itself. A model's word that "the tests pass" is never evidence. */
export interface CheckEvidence {
  command: string;
  passed: boolean;
  exitCode: number | null;
  testsPassed: number | null;
  testsFailed: number | null;
  outputTail: string;
}

/** The check, as lines for the review prompt. Says plainly when no check was run, so the Coach cannot imply one. */
export function evidenceText(check: CheckEvidence | null, notRun?: string): string {
  if (!check) return `KAI did not run a project check${notRun ? ` (${notRun})` : ''}. Do not say any test passed; mark "unverified" if the criteria need one.`;
  const counts = check.testsPassed !== null ? ` ${check.testsPassed} passed, ${check.testsFailed ?? 0} failed.` : '';
  const tail = check.outputTail.trim().slice(-1_200);
  return `KAI ran \`${check.command}\` and it ${check.passed ? 'PASSED' : `FAILED${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`}.${counts}${tail ? `
End of its output:
${tail}` : ''}`;
}

/** How much of the step's diff goes into one review: enough to judge the change, not enough to flood a small model. */
export const REVIEW_DIFF_CHARS = 9_000;

/**
 * The step's real changes, as the Coach reads them. Every file gets an equal share so one large file cannot push the
 * others out, a cut is stated, and a file with no diff is named rather than skipped, so the Coach knows it looked.
 */
export function diffText(files: ReadonlyArray<{ path: string; diff: string }>, limit: number = REVIEW_DIFF_CHARS): string {
  if (files.length === 0) return 'No changed files were found for this step.';
  const share = Math.max(300, Math.floor(limit / files.length));
  let cut = false;
  const parts = files.map((file) => {
    const diff = file.diff.trim();
    if (!diff) return `--- ${file.path} (no text diff: new, binary or unchanged)`;
    if (diff.length <= share) return `--- ${file.path}
${diff}`;
    cut = true;
    return `--- ${file.path}
${diff.slice(0, share)}
… (${(diff.length - share).toLocaleString()} more characters of this file's diff left out)`;
  });
  const header = `${files.length} ${files.length === 1 ? 'file' : 'files'} changed.`;
  const footer = cut ? 'Parts of the diff were left out to keep this short. Read any file yourself for the rest.' : '';
  return [header, ...parts, ...(footer ? [footer] : [])].join('\n\n');
}

/** A step cannot pass while KAI's own check fails, whatever the Coach says. */
export function gateReview(review: { status: GuidedReviewStatus; summary: string }, check: CheckEvidence | null): { status: GuidedReviewStatus; summary: string } {
  if (review.status !== 'ready' || !check || check.passed) return review;
  return { status: 'changes-needed', summary: `KAI's check \`${check.command}\` failed, so this step cannot pass yet. ${review.summary}`.trim() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------------------------------

type Style = GuidedBuild['style'];
type Detail = GuidedBuild['detail'];
type Questions = GuidedBuild['questions'];

export function questionRule(questions: Questions): string {
  return questions === 'blocked' ? 'Ask for clarification only if you are blocked.' : questions === 'decisions' ? 'Ask before major choices.' : 'Ask once before each new step.';
}

function teaching(style: Style, detail: Detail): string {
  return `Explain in a ${style === 'senior-dev' ? 'senior developer' : 'tutor'} style with ${detail} detail.`;
}

const PLAN_SHAPE = '{"title": string, "steps": [{"id": string, "title": string, "why": string, "where": string, "instructions": string, "code"?: string, "acceptanceCriteria": string[], "needsApproval"?: string}]}';

const READ_FIRST = 'Before planning, inspect the project: list its files and read the README, manifests and workspace configuration. Map the major apps, packages, entry points and tests, then read the source files that define the relevant behavior and follow imports and tests until you know which files own the change. The repository map may be truncated, so treat it as an index. Do not claim to have read every file; state any coverage limits in the plan title or a short note before the JSON.';

const STEP_RULES = 'Every step must change something: no step that only reads, tours or investigates the code (do that reading yourself, now). Keep each step small enough for one Builder handoff. In "where" give exactly one project-relative file path, optionally with :line. Never put two paths in "where"; name related files in "instructions". Give concrete, beginner-friendly instructions and one to three checks a person or a command can verify.';

export function planPrompt(request: string, style: Style, detail: Detail, questions: Questions): string {
  return `Create a coding plan for this request: ${request}\n\n${READ_FIRST}\n\n${teaching(style, detail)} ${questionRule(questions)}\nReturn valid JSON only, in this shape: ${PLAN_SHAPE}.\n${STEP_RULES} Do not edit files.`;
}

/** The Studio brief with the instruction line Studio puts in front of it removed, so only the brief itself is kept. */
export function briefFromLaunchPrompt(prompt: string): string {
  return prompt.replace(/^Use this Project Studio brief as the source of truth\.[^\n]*\n\n/, '').trim();
}

const BRIEF_RULES = 'The brief below is the source of truth. Everything under "What you decided" was chosen by the person: build exactly that and do not reopen it. Anything under "Assumptions" marked "assumed" was a guess by the interviewer. When a step depends on an assumption marked "high risk", set "needsApproval" on that step to one sentence naming the assumption, so the person confirms it before anything is built. Topics under "Left to the agents" are yours to decide sensibly. Do not add steps for work the brief rules out.';

/** The plan prompt when Guided Build was started from a Studio brief: the brief replaces a typed request. */
export function planFromBriefPrompt(brief: string, style: Style, detail: Detail, questions: Questions): string {
  return `Create a coding plan from this Project Studio brief.\n\n${BRIEF_RULES}\n\n--- BRIEF ---\n${brief}\n--- END OF BRIEF ---\n\n${READ_FIRST}\n\n${teaching(style, detail)} ${questionRule(questions)}\nReturn valid JSON only, in this shape: ${PLAN_SHAPE}.\n${STEP_RULES} Do not edit files.`;
}

export function addIdeaPrompt(idea: string, planTitle: string, steps: readonly GuidedBuildStep[], style: Style, detail: Detail, questions: Questions): string {
  const current = steps.map((step, index) => `${index + 1}. ${step.title}\nWhy: ${step.why}\nFile: ${step.where}\nChange: ${step.instructions}\nCheck: ${step.acceptanceCriteria.join('; ')}`).join('\n\n');
  return `The user has a new idea to add to their coding plan: ${idea}\n\nCurrent plan: ${planTitle}\n${current}\n\nFit the idea in at the right place, adding, combining or reordering steps and keeping the useful ones. ${teaching(style, detail)} ${questionRule(questions)}\nReturn the complete updated plan as JSON only, in this shape: ${PLAN_SHAPE}.\n${STEP_RULES} Do not edit files.`;
}

export function coachPrompt(message: string, style: Style, detail: Detail, questions: Questions, step?: Pick<GuidedBuildStep, 'title'>): string {
  return `You are the Coach in Guided Build. Answer the user's message conversationally, in a few short paragraphs at most, and keep it on the project and the current step${step ? ` ("${step.title}")` : ''}. ${questionRule(questions)} Coach style: ${style}; detail: ${detail}. Do not run Builder or edit files unless the user explicitly presses the Builder action. User message: ${message}`;
}

export function builderStepPrompt(step: GuidedBuildStep): string {
  return `Implement only this Guided Build step.\n\nStep: ${step.title}\nWhy it matters: ${step.why}\nFile: ${step.where}\nInstructions: ${step.instructions}${step.code ? `\nSuggested code: ${step.code}` : ''}\nAcceptance checks:\n${step.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\n\nOpen the changed file(s) in the editor when finished. Do not start later steps.`;
}

export function showCodePrompt(step: GuidedBuildStep | undefined, request: string): string {
  const context = step ? `Current plan step: ${step.title}. Why: ${step.why}. Instructions: ${step.instructions}. Check it by: ${step.acceptanceCriteria.join('; ')}.` : '';
  const file = step?.where ? `Open this file: ${step.where}.` : 'Find the right file and tell me which one you chose.';
  return `Help me make this change myself: ${request}\n${context}\n${file}\nDo not edit files. Show me exactly where to type and the exact code to enter, then explain briefly what it does. Do not ask me questions.`;
}

/** The Builder edits the file for a change the person typed, with the current step as its context. */
export function writeCodePrompt(step: GuidedBuildStep | undefined, request: string): string {
  const context = step ? `Current plan step: ${step.title}. Why: ${step.why}. Instructions: ${step.instructions}. Check it by: ${step.acceptanceCriteria.join('; ')}.` : '';
  const file = step?.where ? `Open this file: ${step.where}.` : 'Find the right file and tell me which one you chose.';
  return `Make this change in the project: ${request}\n${context}\n${file}\nEdit the file for me. Do not ask me questions; make a sensible assumption if needed.`;
}

export function reviewPrompt(step: GuidedBuildStep, changedFiles: readonly string[], evidence?: string): string {
  const changed = [...new Set(changedFiles)].join(', ') || 'No saved changes were reported.';
  return `Review the current Guided Build step using the project's current files. Step: ${step.title}. Why: ${step.why}. Where: ${step.where}. Instructions: ${step.instructions}. Acceptance criteria: ${step.acceptanceCriteria.join('; ')}. Recent changed files: ${changed}.${evidence ? `\n\nEvidence KAI collected:\n${evidence}` : ''}\nReturn JSON only: {"status": "ready" | "changes-needed" | "unverified", "summary": string}, citing file paths and lines where possible. Mark "ready" only when the saved code meets every criterion. Say which checks you ran and which you could not. Do not edit files.`;
}

/** Tool rounds one local Builder turn may take before it must report. A small model that is stuck does not stop on its own. */
export const LOCAL_BUILDER_ROUNDS = 30;

/** The Builder step for a small local model: the same step, plus a clear way to say it cannot do it, so it stops and says so. */
export function localBuilderStepPrompt(step: GuidedBuildStep): string {
  return `${builderStepPrompt(step)}\n\nThis is one small change. Read only what it needs, make the edit with your tools, and stop. If you cannot finish it, or you would otherwise repeat yourself, stop and end your reply with its own line: ${ARCHITECT_STUCK_SENTINEL} followed by one sentence on what blocks you.`;
}

/** Why the Builder gave up, when its reply ends with the stuck marker; null when it did not ask for help. */
export function builderStuckReason(reply: string): string | null {
  const at = reply.lastIndexOf(ARCHITECT_STUCK_SENTINEL);
  if (at < 0) return null;
  return reply.slice(at + ARCHITECT_STUCK_SENTINEL.length).split(/\r?\n/, 1)[0]!.trim().slice(0, 300) || 'it did not say why';
}

/** A one-run choice of who builds, which does not change the saved Builder. */
export interface GuidedRunOverride {
  target: RoleTarget;
  /** True for a small model on this computer or network, which gets the short step prompt and a round limit. */
  local: boolean;
}

export type LearnAction = 'walk' | 'quiz' | 'simpler';

/** What the Coach does when the person asks to learn from the current step, without editing anything. */
export function learnPrompt(kind: LearnAction, step: Pick<GuidedBuildStep, 'title' | 'where' | 'instructions'> | undefined, style: Style, detail: Detail): string {
  const about = step ? `The current step is "${step.title}" in ${step.where || 'the project'}: ${step.instructions}` : 'There is no current step yet.';
  const common = `${about} ${teaching(style, detail)} Do not edit files.`;
  if (kind === 'walk') return `Walk me through this step: what to type, where, and why each part is there. Name the exact file and the place in it, and keep it short enough to follow while I type. ${common}`;
  if (kind === 'quiz') return `Check that I understand this step. Ask me exactly one short question about it, then wait for my answer and do not give the answer yet. ${common}`;
  return `Explain your last answer again in simpler words, with one small everyday example. ${common}`;
}

/**
 * What this plan has used so far, counted from the conversation itself: how many times the Coach (the strong, usually paid
 * model) was asked, how many steps the Builder built, and how many of those went to a stronger model on request. Nothing
 * here is estimated; it is only the requests that were actually sent.
 */
export function guidedUsage(turns: ReadonlyArray<{ role: string; text: string }>): { coachAsks: number; builderRuns: number; strongerRuns: number } {
  let coachAsks = 0;
  let builderRuns = 0;
  let strongerRuns = 0;
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const label = turn.text.trim();
    if (label.startsWith('Coach: ')) coachAsks += 1;
    else if (label.startsWith('Builder: implement')) {
      builderRuns += 1;
      if (/\((?:with|retry with) /.test(label)) strongerRuns += 1;
    }
  }
  return { coachAsks, builderRuns, strongerRuns };
}

/** Below this many tokens a model struggles with a step that spans a few files, so the panel says so. */
export const SMALL_CONTEXT_TOKENS = 16_000;

/**
 * What the server's own model list says about the model a role uses, in words a person can act on. It only reports what
 * the server told us: whether it answered, whether it lists the model, and how large a window it says the model has.
 */
export function describeModelCheck(
  catalog: { models: readonly string[]; source: 'live' | 'preset'; error: string | null; contextLengths?: Readonly<Record<string, number>> },
  model: string,
): { tone: 'success' | 'warning' | 'error'; text: string } {
  if (catalog.error) return { tone: 'error', text: `Could not reach the server: ${catalog.error}` };
  if (catalog.source === 'preset') return { tone: 'warning', text: 'The server did not answer, so this is only the built-in list. Check that it is running and the address is right.' };
  if (!model) return { tone: 'warning', text: `The server answered and lists ${catalog.models.length} ${catalog.models.length === 1 ? 'model' : 'models'}, but no model is chosen for this role.` };
  if (!catalog.models.includes(model)) return { tone: 'error', text: `The server answered, but it does not list "${model}". Pick one it has, or load it there first.` };
  const window = catalog.contextLengths?.[model];
  if (window === undefined) return { tone: 'success', text: `The server answered and lists "${model}". It did not say how large its context window is.` };
  if (window < SMALL_CONTEXT_TOKENS) return { tone: 'warning', text: `The server lists "${model}" with a ${window.toLocaleString()}-token window. That is small: steps that touch several files may not fit.` };
  return { tone: 'success', text: `The server lists "${model}" with a ${window.toLocaleString()}-token window.` };
}

/**
 * A new version of the plan (the Coach fitted an idea in, or the person asked for the plan again) with the person's
 * progress kept. A step matches an earlier one by id, else by title, so a finished step stays finished, a step the person
 * already said yes to is not asked about again, and the current step is the first one still to do. With no earlier plan
 * every step is new and the first is active, as when a plan is first made.
 */
export function mergePlanProgress(next: readonly GuidedBuildStep[], previous: readonly GuidedBuildStep[]): { steps: GuidedBuildStep[]; currentStep: number } {
  const key = (step: Pick<GuidedBuildStep, 'title'>): string => step.title.trim().toLowerCase();
  const merged = next.map((step): GuidedBuildStep => {
    const earlier = previous.find((item) => item.id === step.id) ?? previous.find((item) => key(item) === key(step));
    const { needsApproval, ...rest } = step;
    if (!earlier) return { ...rest, status: 'pending', ...(needsApproval ? { needsApproval } : {}) };
    // Said yes to once, it stays yes; still waiting, it keeps waiting.
    return { ...rest, status: earlier.status === 'complete' ? 'complete' : 'pending', ...(earlier.needsApproval ? { needsApproval: earlier.needsApproval } : {}) };
  });
  const first = merged.findIndex((step) => step.status !== 'complete');
  const currentStep = first === -1 ? Math.max(0, merged.length - 1) : first;
  return { steps: merged.map((step, index) => (index === currentStep && step.status !== 'complete' ? { ...step, status: 'active' } : step)), currentStep };
}
