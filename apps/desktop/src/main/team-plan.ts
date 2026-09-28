import {
  TEAM_ROLE_INFO,
  isBuiltInRole,
  resolveRole,
  roleAutoAdd,
  teamPlanSchema,
  type AgentTeam,
  type ResolvedRole,
  type TeamLike,
  type TeamPart,
  type TeamPlan,
  type TeamRoleConfig,
  type TeamWorkerRoleId,
} from '@kai/contracts';

/** The orchestrator may return this many parts; KAI adds up to two review parts of its own after them. */
const MAX_ORCHESTRATOR_PARTS = 10;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const WORKER_ROLES: readonly TeamWorkerRoleId[] = ['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs'];

export function buildOrchestratorPrompt(goal: string, team?: TeamLike): string {
  const builtIn = WORKER_ROLES.map((role) => `- "${role}": ${TEAM_ROLE_INFO[role].label}. ${TEAM_ROLE_INFO[role].description}`);
  const custom = (team?.custom ?? []).map((role) => `- "${role.id}": ${role.label} (${role.access === 'read' ? 'read-only' : 'edits files'}). ${role.description}`.trim());
  const roles = [...builtIn, ...custom].join('\n');
  return [
    'You are the orchestrator of a team of coding agents. Split the goal below into parts, one per teammate.',
    'You may read files in this project to understand it. Do not create, edit or delete anything.',
    '',
    `Goal: ${goal}`,
    '',
    'Roles you can assign:',
    roles,
    '',
    'Rules:',
    `- Return between 1 and ${MAX_ORCHESTRATOR_PARTS} parts. Fewer is better; one part per real area of work.`,
    '- Each part must be understandable on its own: name the files, folders and behaviour it covers.',
    '- Use "dependsOn" (a list of part ids) only when a part truly needs an earlier part finished first, for example tests after the code they test.',
    '- Include a "tests" part when code changes. Include "docs" only when behaviour users see changes or the goal asks for it.',
    '- Reviews are added automatically when needed, so you do not have to add them.',
    '- "paths" lists the folders or files a part should stay within.',
    '- "effort" is "light" for small mechanical edits (renames, copy, styling, config), "heavy" for design, cross-cutting changes or hard bugs, and "standard" otherwise. KAI picks a smaller or larger model from it.',
    '',
    'Reply with ONLY a JSON object, no other text, in exactly this shape:',
    '{"summary":"one sentence","parts":[{"id":"ui","title":"Login form","role":"frontend","prompt":"What to do, in full.","dependsOn":[],"paths":["src/components/"],"effort":"standard"}]}',
  ].join('\n');
}

export function buildRepairPrompt(error: string): string {
  return [
    `Your previous reply could not be used: ${error}`,
    'Reply again with ONLY the JSON object described before, no other text and no code fences.',
  ].join('\n');
}

export type ParsedTeamPlan = { ok: true; plan: TeamPlan } | { ok: false; error: string };

/** Reads the orchestrator's reply. Accepts fenced or chatty replies, but never a plan that does not hold together. */
export function parseTeamPlan(output: string, team?: TeamLike): ParsedTeamPlan {
  const json = extractJsonObject(output);
  if (!json) return { ok: false, error: 'the reply did not contain a JSON object' };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `the JSON was malformed (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = teamPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join('.') || 'the plan'}: ${issue.message}` };
  }
  const plan = parsed.data;
  const unknown = plan.parts.find((part) => !isBuiltInRole(part.role) && !team?.custom?.some((role) => role.id === part.role));
  if (unknown) return { ok: false, error: `part "${unknown.id}" uses the role "${unknown.role}", which is not one of the team's roles` };
  if (plan.parts.length > MAX_ORCHESTRATOR_PARTS) return { ok: false, error: `it returned ${plan.parts.length} parts; the limit is ${MAX_ORCHESTRATOR_PARTS}` };
  const structure = checkStructure(plan.parts);
  return structure ? { ok: false, error: structure } : { ok: true, plan };
}

function extractJsonObject(output: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output);
  const source = fenced?.[1] ?? output;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  return start >= 0 && end > start ? source.slice(start, end + 1) : null;
}

/** Ids must be usable, unique and point at real parts, and the dependencies must not loop. */
export function checkStructure(parts: readonly TeamPart[]): string | null {
  const ids = new Set<string>();
  for (const part of parts) {
    if (!STEP_ID.test(part.id)) return `part id "${part.id}" may only use letters, numbers, "-" and "_"`;
    if (ids.has(part.id)) return `part id "${part.id}" is used twice`;
    ids.add(part.id);
  }
  for (const part of parts) {
    for (const dependency of part.dependsOn) {
      if (dependency === part.id) return `part "${part.id}" depends on itself`;
      if (!ids.has(dependency)) return `part "${part.id}" depends on "${dependency}", which does not exist`;
    }
  }
  return orderParts(parts) ? null : 'the parts depend on each other in a loop';
}

/** Parts with their dependencies first, keeping the given order otherwise. Null when there is a loop. */
export function orderParts(parts: readonly TeamPart[]): TeamPart[] | null {
  const remaining = [...parts];
  const done = new Set<string>();
  const ordered: TeamPart[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((part) => part.dependsOn.every((dependency) => done.has(dependency)));
    if (index < 0) return null;
    for (const next of remaining.splice(index, 1)) {
      ordered.push(next);
      done.add(next.id);
    }
  }
  return ordered;
}

// Words that make a change worth a second, security-minded look. Deliberately narrow: a needless review costs
// time, and the user can delete an added part from the plan card.
const SENSITIVE =
  /\b(auth(?:entication|orization|orize)?|log-?in|sign-?in|sign-?up|password|passwd|secret|credential|session|cookie|jwt|oauth|permission|rbac|payment|billing|stripe|sql|database|migration|api[-_ ]?key|encrypt\w*|csrf|cors|upload)\b|\.env\b/gi;

export function sensitiveTopics(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(SENSITIVE)) found.add(match[0].toLowerCase());
  }
  return [...found].slice(0, 6);
}

export interface GuardedParts {
  parts: TeamPart[];
  warnings: string[];
}

interface AddedPart {
  id: string;
  title: string;
  /** How the part is named in a note: "Added a security review because ...". */
  noun: string;
  prompt: (topics: string[]) => string;
}

// What KAI can add to a job by itself, in the order it does so. Reviewers come last so they see everything.
const ADDED_PARTS: ReadonlyArray<readonly [TeamWorkerRoleId, AddedPart]> = [
  ['tests', {
    id: 'tests',
    title: 'Tests',
    noun: 'test part',
    prompt: () => 'Write or update tests for the changes made by the earlier parts, run them, and report exactly what passed and failed.',
  }],
  ['docs', {
    id: 'docs',
    title: 'Documentation',
    noun: 'documentation part',
    prompt: () => 'Update the documentation (README, comments, usage notes) so it matches the changes made by the earlier parts. Do not change code.',
  }],
  ['securityReviewer', {
    id: 'security-review',
    title: 'Security review',
    noun: 'security review',
    prompt: (topics) => `Review every change made by the earlier parts for security problems.${topics.length > 0 ? ` This job touches: ${topics.join(', ')}.` : ''} Look for missing input checks, injection, broken access control, unsafe storage or logging of secrets, and insecure defaults.`,
  }],
  ['codeReviewer', {
    id: 'code-review',
    title: 'Code review',
    noun: 'code review',
    prompt: () => 'Review all changes made by the earlier parts for correctness, missed requirements, edge cases and quality. Say clearly what is wrong and where.',
  }],
];

/**
 * KAI's own safeguards, set per role in the team settings. By default a code review is added to every job and a
 * security review to jobs that touch sensitive areas; a role set to "never" is left to the orchestrator.
 */
export function applyGuardrails(goal: string, parts: readonly TeamPart[], team?: Pick<AgentTeam, 'roles'>): GuardedParts {
  const result = [...parts];
  const warnings: string[] = [];
  const topics = sensitiveTopics(goal, ...result.flatMap((part) => [part.title, part.prompt, ...part.paths]));
  const freeId = (base: string): string => {
    let id = base;
    for (let n = 2; result.some((part) => part.id === id); n += 1) id = `${base}-${n}`;
    return id;
  };

  for (const [role, added] of ADDED_PARTS) {
    if (result.some((part) => part.role === role)) continue;
    const mode = roleAutoAdd(team?.roles[role], role);
    const wanted = mode === 'always' || (mode === 'sensitive' && topics.length > 0);
    // Whatever the earlier parts changed is what this part works on; with nothing changed there is nothing to add.
    const editing = result.filter((part) => resolveRole(team, part.role).access === 'edit');
    if (!wanted || editing.length === 0) continue;
    result.push({
      id: freeId(added.id),
      title: added.title,
      role,
      prompt: added.prompt(topics),
      dependsOn: editing.map((part) => part.id),
      paths: [],
    });
    warnings.push(mode === 'sensitive'
      ? `Added a ${added.noun} because this job touches: ${topics.join(', ')}.`
      : `Added a ${added.noun}: your team settings add one to every job.`);
  }
  return { parts: result, warnings };
}

/** The full instruction one agent receives for its part of the job. */
export function buildStepPrompt(goal: string, part: TeamPart, config: TeamRoleConfig | undefined, role?: ResolvedRole): string {
  const info = role ?? resolveRole(undefined, part.role);
  const lines = [
    `You are the ${info.label} on a team of coding agents working on one project. Do only your part; teammates handle the rest.`,
    '',
    `Overall goal: ${goal}`,
    '',
    `Your part - ${part.title}:`,
    part.prompt,
    '',
    part.paths.length > 0 ? `Stay within: ${part.paths.join(', ')}.` : 'Keep changes to the files your part needs.',
  ];
  if (info.access === 'read') {
    lines.push('This is a read-only role: do not create, edit or delete any files. Report what you find, with file and line where you can.');
  } else {
    lines.push('When you finish, list the files you changed and how to check them.');
  }
  if (part.role === 'securityReviewer') {
    lines.push(
      'End your reply with exactly one line: "VERDICT: PASS" or "VERDICT: BLOCK - <one sentence reason>".',
      'Use BLOCK only for a serious problem that should stop the job, such as an exposed secret, broken access control or injection. Smaller findings still get PASS, described above the verdict.',
    );
  }
  if (config?.instructions.trim()) lines.push('', `Extra guidance for this role: ${config.instructions.trim()}`);
  return lines.join('\n');
}

export interface ReviewVerdict {
  result: 'pass' | 'block';
  reason: string;
}

/**
 * Reads a security reviewer's final line. A missing or unclear verdict counts as a block: stopping to ask is
 * the safe way to fail.
 */
export function parseVerdict(output: string): ReviewVerdict {
  const lines = output.split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = /^\W*verdict\W*\s*[:=-]\s*(pass|block)\b\W*(.*)$/i.exec(line.trim());
    if (match) {
      return { result: match[1].toLowerCase() as 'pass' | 'block', reason: match[2].replace(/^[-:\s]+/, '').trim() };
    }
  }
  return { result: 'block', reason: 'The reviewer did not end with a clear PASS or BLOCK verdict.' };
}

/** A part that edits files, as the runner sees it when a check fails. */
export interface OwnerStep {
  id: string;
  role: string;
  paths: readonly string[];
}

// Bare file names count only with a code-like extension, so "1.5" or "e.g." in test output is not taken for a file.
const FILE_EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|css|scss|html|json|md|vue|svelte|sql|yml|yaml|toml|c|cc|cpp|h|swift';
const PATH_TOKEN = new RegExp(`[\\w@.~-]+(?:[\\\\/][\\w@.~-]+)+\\.\\w{1,6}|[\\w-]+\\.(?:${FILE_EXTENSIONS})\\b`, 'g');

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** The file paths a check's output mentions, normalised to forward slashes. */
export function failingPaths(output: string): string[] {
  return [...new Set((output.match(PATH_TOKEN) ?? []).map(normalizePath))];
}

function pathMatches(candidate: string, ownerPath: string): boolean {
  const owned = normalizePath(ownerPath);
  if (!owned) return false;
  return candidate === owned || candidate.endsWith(`/${owned}`) || candidate.startsWith(`${owned}/`) || candidate.includes(`/${owned}/`);
}

const FIX_PRIORITY: readonly string[] = ['backend', 'frontend', 'tests', 'docs'];

export interface FailureRoute {
  ownerIds: string[];
  /** "paths" when the output named files a part owns; "fallback" when it named none KAI could match. */
  reason: 'paths' | 'fallback';
}

/**
 * Who should fix a failed check. Every part that owns a file the output names; when none does, the first editing
 * part by role (backend, then frontend, tests, docs), since a failure with no clear owner is most often the logic.
 */
export function routeFailure(output: string, owners: readonly OwnerStep[]): FailureRoute {
  const mentioned = failingPaths(output);
  const matched = owners.filter((owner) => owner.paths.some((owned) => mentioned.some((path) => pathMatches(path, owned))));
  if (matched.length > 0) return { ownerIds: matched.map((owner) => owner.id), reason: 'paths' };
  for (const role of FIX_PRIORITY) {
    const owner = owners.find((candidate) => candidate.role === role);
    if (owner) return { ownerIds: [owner.id], reason: 'fallback' };
  }
  // No built-in editing role: a custom editing role is the only thing left to send the failure to.
  const first = owners.at(0);
  return { ownerIds: first ? [first.id] : [], reason: 'fallback' };
}

/** The instruction a fixing part receives: its original task, then what the check said. */
export function buildFixPrompt(original: string, command: string, round: number, output: string): string {
  const tail = output.trim().length > 4_000 ? `[earlier output left out]\n${output.trim().slice(-4_000)}` : output.trim();
  return [
    `FIX ROUND ${round}. The check "${command}" failed after the team's work. Repair the problems in your own area.`,
    'If the failure clearly belongs to a different area, say so and change nothing there.',
    '',
    'What the check printed:',
    tail || '(no output)',
    '',
    'Your original task, for reference:',
    original,
  ].join('\n');
}

/** The earlier work a later part is shown, so agents that cannot share a session still share results. */
export function handoffSection(
  earlier: ReadonlyArray<{ label: string; agent: string; output?: string }>,
  perStepLimit = 2_000,
): string {
  const usable = earlier.filter((step) => step.output?.trim());
  if (usable.length === 0) return '';
  const blocks = usable.map((step) => {
    const text = (step.output ?? '').trim();
    const shown = text.length > perStepLimit ? `${text.slice(0, perStepLimit)}\n[shortened]` : text;
    return `### ${step.label} (${step.agent})\n${shown}`;
  });
  return `\n\nWork already done by earlier parts of this job:\n${blocks.join('\n\n')}`;
}
