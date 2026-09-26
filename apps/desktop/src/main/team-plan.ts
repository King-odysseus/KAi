import {
  TEAM_ROLE_INFO,
  teamPlanSchema,
  type TeamPart,
  type TeamPlan,
  type TeamRoleConfig,
  type TeamWorkerRoleId,
} from '@kai/contracts';

/** The orchestrator may return this many parts; KAI adds up to two review parts of its own after them. */
const MAX_ORCHESTRATOR_PARTS = 10;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const WORKER_ROLES: readonly TeamWorkerRoleId[] = ['frontend', 'backend', 'tests', 'securityReviewer', 'codeReviewer', 'docs'];

export function buildOrchestratorPrompt(goal: string): string {
  const roles = WORKER_ROLES.map((role) => `- "${role}": ${TEAM_ROLE_INFO[role].label}. ${TEAM_ROLE_INFO[role].description}`).join('\n');
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
    '',
    'Reply with ONLY a JSON object, no other text, in exactly this shape:',
    '{"summary":"one sentence","parts":[{"id":"ui","title":"Login form","role":"frontend","prompt":"What to do, in full.","dependsOn":[],"paths":["src/components/"]}]}',
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
export function parseTeamPlan(output: string): ParsedTeamPlan {
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

/** KAI's own safeguards: a security review when the job touches sensitive areas, and a code review always. */
export function applyGuardrails(goal: string, parts: readonly TeamPart[]): GuardedParts {
  const result = [...parts];
  const warnings: string[] = [];
  const editing = result.filter((part) => TEAM_ROLE_INFO[part.role].access === 'edit');
  const dependsOn = editing.map((part) => part.id);
  const topics = sensitiveTopics(goal, ...result.flatMap((part) => [part.title, part.prompt, ...part.paths]));
  const freeId = (base: string): string => {
    let id = base;
    for (let n = 2; result.some((part) => part.id === id); n += 1) id = `${base}-${n}`;
    return id;
  };

  if (!result.some((part) => part.role === 'securityReviewer') && topics.length > 0 && editing.length > 0) {
    result.push({
      id: freeId('security-review'),
      title: 'Security review',
      role: 'securityReviewer',
      prompt: `Review every change made by the earlier parts for security problems. This job touches: ${topics.join(', ')}. Look for missing input checks, injection, broken access control, unsafe storage or logging of secrets, and insecure defaults.`,
      dependsOn,
      paths: [],
    });
    warnings.push(`Added a security review because this job touches: ${topics.join(', ')}.`);
  }
  if (!result.some((part) => part.role === 'codeReviewer') && editing.length > 0) {
    result.push({
      id: freeId('code-review'),
      title: 'Code review',
      role: 'codeReviewer',
      prompt: 'Review all changes made by the earlier parts for correctness, missed requirements, edge cases and quality. Say clearly what is wrong and where.',
      dependsOn,
      paths: [],
    });
    warnings.push('Added a code review of the finished work.');
  }
  return { parts: result, warnings };
}

/** The full instruction one agent receives for its part of the job. */
export function buildStepPrompt(goal: string, part: TeamPart, config: TeamRoleConfig | undefined): string {
  const info = TEAM_ROLE_INFO[part.role];
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
