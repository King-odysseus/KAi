import { DEFAULT_AWAY_POLICY } from '@kai/contracts';
import { isOwnNetworkApi, type CrewAwayPolicy, type CrewConfig, type CrewDesign, type CrewRun, type CrewTask } from '@kai/contracts';
import { boardSummary, roleAccess } from './crew-engine';

/**
 * What the Lead and the reviewers are asked, and how their replies are read. Kept short on purpose: every agent gets
 * the task and the board, never the chat history, so a long project does not make each call more expensive.
 */

export interface PlannedTask {
  id: string;
  title: string;
  role: string;
  description: string;
  acceptance: string[];
  dependsOn: string[];
  designRef: string | null;
  /** The phase of the plan this task belongs to, when the plan has phases. */
  phase: string | null;
}

/** What the planner is told about Open Pencil: the pages to build, or that a designer should draw them first. */
function designPlanLines(config: CrewConfig, design: CrewDesign | null): string[] {
  const designer = config.roles.find((role) => role.kind === 'designer');
  if (design && design.state === 'running' && design.pages.length > 0) {
    return [
      '',
      'Open Pencil already holds these design pages. Give each screen its own build task and set "designRef" to the exact page name:',
      ...design.pages.slice(0, 60).map((page) => `- ${page.name}`),
      ...(designer ? [`Use the role ${designer.id} for any page that still needs drawing or changing.`] : []),
    ];
  }
  if (designer) {
    return ['', `There is no design in Open Pencil yet. Start with tasks for the role ${designer.id} that draw the key pages, set "designRef" to each page name, and make the build tasks for those pages depend on them.`];
  }
  return [];
}

/** Tells the Lead which design page a task builds and whether that page is in Open Pencil right now. */
function designReviewLines(run: CrewRun, task: CrewTask): string[] {
  if (!task.designRef) return [];
  const wanted = task.designRef.toLowerCase();
  const present = run.design?.state === 'running' ? run.design.pages.some((page) => page.name.toLowerCase() === wanted || page.id === task.designRef) : null;
  return [
    '',
    `This task builds the design page "${task.designRef}". ${present === null ? 'Open Pencil could not be read just now, so check the code against the page you can see.' : present ? 'It is in Open Pencil.' : 'No page with that name is in Open Pencil right now; say so if it matters.'}`,
  ];
}

export function planPrompt(goal: string, config: CrewConfig, conventions: string, existing: Pick<CrewRun, 'tasks'> & { followUp?: string | null }, design: CrewDesign | null = null): string {
  const done = existing.tasks.filter((task) => task.status === 'accepted' && !task.proposed).map((task) => task.title);
  const roles = config.roles.filter((role) => roleAccess(role) === 'edit' || role.kind === 'security' || role.kind === 'reviewer');
  const localBuilders = roles.filter((role) => roleAccess(role) === 'edit' && role.execution === 'api' && role.api && isOwnNetworkApi(role.api));
  return [
    'You are the Lead of a small crew that will build a project. Read the project, then split the goal into tasks.',
    'Do not change any files. Reply with one JSON object and nothing else.',
    '',
    `Goal: ${goal}`,
    '',
    'Roles that can be given a task (use the id):',
    ...roles.map((role) => `- ${role.id}: ${role.label}${roleAccess(role) === 'edit' ? ' (writes code)' : ' (reviews, read-only)'}${localBuilders.some((builder) => builder.id === role.id) ? ' (small local model; assign only focused microtasks)' : ''}`),
    ...(localBuilders.length ? ['', 'Local builder task sizing:', `These roles use local models: ${localBuilders.map((role) => role.id).join(', ')}. Give each one a tiny, concrete task that changes one behavior in one or two files and can be finished in one short turn. If a feature needs more work, make separate ordered task cards with explicit "dependsOn" links; each card must have its own checkable acceptance criteria and be independently reviewable. Do not give a local model a whole feature, a multi-file refactor, or a task that mixes investigation, implementation and cleanup.`] : []),
    ...(conventions.trim() ? ['', 'How this developer usually builds things (follow these unless the goal says otherwise):', conventions.trim()] : []),
    ...designPlanLines(config, design),
    ...(existing.tasks.length > 0 ? ['', 'The board already has these tasks; add only what is missing:', boardSummary(existing)] : []),
    ...(existing.followUp ? ['', 'The earlier work is finished and accepted:', ...done.slice(0, 30).map((title) => `- ${title}`), '', `The user has now asked for more. Plan only this, building on what is done: ${existing.followUp}`, 'Do not repeat tasks that are already accepted. Prefer 1 to 6 tasks. Anything that runs, builds, installs or commits the project is a task for a role that writes code.', 'How to plan it: first read any plan file the goal names and find which parts of it the accepted tasks above already cover; then plan the next unfinished part, and only that. A request such as "continue" or "next phase" means exactly that.', 'If the plan truly has nothing left to build, reply {"tasks":[],"note":"one plain sentence saying why"} instead of inventing work.'] : []),
    '',
    'Rules for the tasks:',
    '- Small enough for one agent to finish in one sitting. Prefer 5 to 14 tasks.',
    ...(localBuilders.length ? ['- For tasks assigned to a local builder, keep each card to one concrete code change, one or two files, and 1 to 3 acceptance checks. Split bigger work into dependency-ordered cards; Crew checks and reviews each card before accepting it.'] : []),
    '- Each task has 1 to 5 acceptance criteria that can be checked by reading the code or running a command.',
    '- Every build task names the exact files it will change in its description. Split a task that needs more than 3 files or more than one independent behavior into small dependency-ordered tasks.',
    '- Never write a criterion only the person can meet (their approval, their sign-off, "every change is one they approved"). The crew cannot satisfy it, so the task would stop and wait. Put what needs their yes under "approvals" instead, and write the criterion as something the crew can check.',
    '- "dependsOn" lists task ids that must be accepted first. Use it only where order truly matters.',
    '- Give code tasks to a role that writes code. Never give a task to a read-only role.',
    '- When the goal or its plan is divided into phases, give every task a "phase": the name of the phase as the plan names it ("Phase 1: Shell, gating, access"). Otherwise leave "phase" null.',
    '- If the plan or the project rules say something needs the person\'s approval before it is built (a new package or dependency, a paid service, deleting data), do NOT assume they approved it. List it under "approvals" with a plain one-line explanation of what it is and why it is wanted, written for someone who is not very technical. Leave "approvals" empty when nothing needs approval.',
    '',
    'Reply shape:',
    '{"tasks":[{"id":"short-kebab-id","title":"...","role":"builder","description":"Change only: src/file.ts; ...","acceptance":["..."],"dependsOn":[],"designRef":null,"phase":null}],"approvals":[{"what":"zod","why":"A small library that checks the messages inside the app are well-formed."}]}',
  ].join('\n');
}

/** Anything that shows on screen is checked by looking at it, not by asking the person. */
export const BROWSER_CHECK_LINE = 'To check anything that shows on screen (a page, a layout, a button, that a change left the rest of the app as it was), start the app if it is not running and look at it yourself with the browser tools (the playwright tools: navigate, snapshot, screenshot). Do that instead of asking the person to look.';

/**
 * A task several rounds in is usually stuck on wording, a report detail or a criterion read two ways, not on broken
 * work: two tasks went to round 11 and 13 that way. From round 3 the reviewer is told to accept and note it instead.
 */
export function lateRoundLines(task: Pick<CrewTask, 'round'>): string[] {
  if (task.round < 3) return [];
  return [`This task is on round ${task.round}. Do not send it back again over wording, a detail of a report, or a criterion that can be read more than one way: accept it and put the disagreement in "notes". Send it back only for something actually broken or missing.`];
}

/**
 * While the person is away, a reviewer is told to settle what it can check or undo, and to leave only what is truly
 * theirs (a secret, an account, money, security, deleting work) as a question.
 */
export function awayReviewLines(run: Pick<CrewRun, 'away'>): string[] {
  if (!run.away?.enabled) return [];
  const forbidden = forbiddenWhileAway(run.away.policy ?? DEFAULT_AWAY_POLICY);
  return [
    `The person is away from the computer and has asked the crew to keep going. Do not use "needsYou" for something you can check yourself (run the tests, look at the app in the browser) or for a choice that can be undone later: make the reversible choice, check it, and put what the person should look at when they are back in "notes". Use "needsYou" only for ${forbidden.length > 0 ? forbidden.join(', ') : 'a secret or an account only they have'}.`,
    ...((run.away.policy?.other ?? '').trim() ? [`The person's own rule while away: ${run.away.policy!.other.trim()}`] : []),
  ];
}

/** What the person did not allow while away, as plain phrases. */
export function forbiddenWhileAway(policy: CrewAwayPolicy): string[] {
  return [
    'a secret or an account only they have',
    ...(policy.dependencies ? [] : ['adding a dependency or package']),
    ...(policy.paid ? [] : ['anything that costs money (a paid service, a plan, an upgrade)']),
    ...(policy.security ? [] : ['a security or permission change']),
    ...(policy.deleteWork ? [] : ["deleting or overwriting the person's work"]),
  ];
}

/** What the person allowed while away, as plain phrases. */
export function allowedWhileAway(policy: CrewAwayPolicy): string[] {
  return [
    ...(policy.retry ? ['retry a task with a different instruction'] : []),
    ...(policy.skip ? ['skip a task the goal does not need'] : []),
    ...(policy.reversible ? ['make a code choice that can be undone (keep or revert a small change, adjust a check so it allows exactly the approved changes, record evidence in the report)'] : []),
    ...(policy.dependencies ? ['add a dependency or package'] : []),
    ...(policy.paid ? ['use something that costs money'] : []),
    ...(policy.security ? ['make a security or permission change'] : []),
    ...(policy.deleteWork ? ["delete or overwrite the person's work"] : []),
  ];
}

export function reviewPrompt(run: CrewRun, task: CrewTask, builderReply: string, checkNote?: string): string {
  return `${reviewPromptBase(run, task, builderReply, checkNote)}\n\n${REVIEW_SCOPE_RULE}`;
}

function reviewPromptBase(run: CrewRun, task: CrewTask, builderReply: string, checkNote?: string): string {
  return [
    'You are the Lead. Check this finished task against its acceptance criteria by reading the changed code and, where it helps, running a command. Do not change any files.',
    '',
    `Project goal: ${run.goal}`,
    `Task: ${task.title}`,
    task.description,
    '',
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    ...designReviewLines(run, task),
    ...(task.files.length > 0 ? ['', `Files the builder reported changing: ${task.files.slice(0, 40).join(', ')}`] : []),
    ...(checkNote ? ['', checkNote] : []),
    '',
    'The builder said:',
    builderReply.trim().slice(-2_500) || '(no reply)',
    '',
    BROWSER_CHECK_LINE,
    'A criterion that asks for the person\'s approval or sign-off cannot be met by the crew: judge the work itself, and say in "notes" what needs their approval. Do not stop the task for it.',
    ...lateRoundLines(task),
    ...awayReviewLines(run),
    '',
    'Reply with one JSON object and nothing else:',
    '{"verdict":"accept"} when every criterion is met,',
    '{"verdict":"sendBack","feedback":"what is wrong, naming the criterion"} when the builder can fix it,',
    '{"verdict":"needsYou","feedback":"the decision only the user can make"} when it cannot be fixed without them.',
  ].join('\n');
}

/** The verdict shape every reviewer role replies with. */
const REVIEW_SHAPE = [
  'Reply with one JSON object and nothing else:',
  '{"verdict":"accept"} when there is nothing to fix,',
  '{"verdict":"sendBack","feedback":"the specific problem and where"} for a problem the builder can fix,',
  '{"verdict":"needsYou","feedback":"why this must stop and ask"} for a problem that is serious or needs a decision.',
];

function reviewPreamble(run: CrewRun, task: CrewTask): string[] {
  return [
    `Project goal: ${run.goal}`,
    `Task: ${task.title}`,
    ...(task.files.length > 0 ? [`Files changed: ${task.files.slice(0, 40).join(', ')}`] : []),
    '',
    BROWSER_CHECK_LINE,
    ...lateRoundLines(task),
    ...awayReviewLines(run),
    '',
    ...REVIEW_SHAPE,
  ];
}

export function securityPrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the security reviewer. Review the code this task changed for secrets in code, missing authentication or authorisation, unsafe input handling, data exposure and risky defaults. Do not change any files.',
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** The tester runs the real checks; it does not fix them. */
export function testerPrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the tester. Run the project\'s real check command against this finished task and judge it against the task\'s acceptance criteria. Do not change any files.',
    'If the check cannot run because of a missing dependency, environment or service, say that and use "needsYou" rather than pretending it passed.',
    '',
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** The auditor reviews one named risk area; the role's own guidance says which. */
export function auditorPrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the auditor. Review this finished task for the risk area named in your role guidance: accessibility, performance, privacy, reliability or dependencies. Report evidence from the code or a local run, not opinions. Do not change any files.',
    'If your guidance names no area, review for the risk this task most plausibly introduces and say which.',
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** Unlicensed use and missing attribution: the finished task's new dependencies, assets, models and pasted code. */
export function licensePrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the licence checker. Review this finished task for anything it added or changed that is used without a licence that allows it, or without the attribution a licence requires: new dependencies, fonts, images, audio, models, datasets and code copied from elsewhere. Read the licence each one carries and compare it with how this project ships. Report evidence, not opinions. Do not change any files and do not give a legal verdict.',
    'If the task added nothing that carries a licence, accept it.',
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** Law and data rules: what the finished task does that a country the app is distributed in regulates. */
export function compliancePrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the compliance checker. Review this finished task for behaviour that the laws or data rules of the countries named in your role guidance regulate: personal data, children, payments, consent, retention, transfers, accessibility, encryption and platform policy. Look each rule up in a current source rather than relying on memory. Report evidence, not opinions. Do not change any files and do not give legal advice.',
    'If your guidance names no country, say so and use "needsYou" only when the task touches regulated behaviour; otherwise accept it.',
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** A plain reviewer: correctness and the acceptance criteria, with no speciality. */
export function reviewerPrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the reviewer. Check this finished task against its acceptance criteria by reading the changed code and, where it helps, running a read-only command. Do not change any files.',
    '',
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    ...reviewPreamble(run, task),
  ].join('\n');
}

/** The prompt for a reviewer kind. The caller appends the role's own instructions. */
/**
 * What a reviewer may stop a task for. A crew that sent tasks back for concerns outside them (an upgrade, a risk for a
 * later phase) spent money going round in circles, so only a broken criterion or something unsafe to ship blocks.
 */
export const REVIEW_SCOPE_RULE = 'Scope: send the task back, or block it, only for something that breaks one of its acceptance criteria or is unsafe to ship. Anything else you notice (an upgrade, style, a risk outside this task, something for a later phase) goes in an optional "notes" list of short plain sentences, and does not stop the task being accepted. For example {"verdict":"accept","notes":["The Electron version is past end of support; worth upgrading in a later phase."]}.';

export function reviewRolePrompt(kind: 'security' | 'tester' | 'auditor' | 'license' | 'compliance' | 'reviewer', run: CrewRun, task: CrewTask): string {
  return `${reviewRoleBase(kind, run, task)}\n\n${REVIEW_SCOPE_RULE}`;
}

function reviewRoleBase(kind: 'security' | 'tester' | 'auditor' | 'license' | 'compliance' | 'reviewer', run: CrewRun, task: CrewTask): string {
  switch (kind) {
    case 'security':
      return securityPrompt(run, task);
    case 'tester':
      return testerPrompt(run, task);
    case 'auditor':
      return auditorPrompt(run, task);
    case 'license':
      return licensePrompt(run, task);
    case 'compliance':
      return compliancePrompt(run, task);
    case 'reviewer':
      return reviewerPrompt(run, task);
  }
}

export function retryPrompt(kind: 'plan' | 'review' | 'stuck' | 'coverage' | 'away'): string {
  if (kind === 'coverage') return 'Your previous reply could not be used. Reply again with only one JSON object such as {"complete":true} or {"complete":false,"remaining":["Phase 1: ..."]}, and no other text.';
  if (kind === 'plan') return 'Your previous reply could not be used. Reply again with only the JSON object {"tasks":[...]} and no other text.';
  if (kind === 'away') return 'Your previous reply could not be used. Reply again with only one JSON object such as {"choice":1,"reason":"...","check":"..."}, {"choice":"own","instruction":"...","reason":"...","check":"..."} or {"choice":"none","reason":"..."}, and no other text.';
  if (kind === 'stuck') return 'Your previous reply could not be used. Reply again with only one JSON object such as {"decision":"skip","reason":"..."} or {"decision":"retry","guidance":"..."} or {"decision":"ask","reason":"..."}, and no other text.';
  return 'Your previous reply could not be used. Reply again with only one JSON object such as {"verdict":"accept"} or {"verdict":"sendBack","feedback":"..."}, and no other text.';
}

/**
 * The Lead's call on a task that has run out of retries. The crew is meant to keep going on its own, so the Lead is
 * asked to decide first and to hand the question to the user only for something that is genuinely theirs to choose.
 */
export function stuckPrompt(run: CrewRun, task: CrewTask): string {
  const history = task.reviews.slice(-4).map((review) => `- ${review.reviewer}, round ${review.round}, ${review.verdict}${review.feedback ? `: ${review.feedback.slice(0, 400)}` : ''}`);
  return [
    'You are the Lead. A task has failed or been sent back too many times and the crew has stopped on it. Decide what happens next so the crew can keep working without the user.',
    '',
    `Project goal: ${run.goal}`,
    `Task: ${task.title}`,
    task.description,
    '',
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    `Why it stopped: ${run.ask?.message ?? task.note}`,
    ...(task.note ? [`Last note: ${task.note}`] : []),
    ...(history.length > 0 ? ['', 'Recent verdicts:', ...history] : []),
    '',
    'Reply with only one JSON object:',
    '- {"decision":"retry","guidance":"...","lesson":"..."} when a specific, different instruction would change the outcome. The guidance must say what to do differently; repeating the same request will fail the same way. Add "lesson" only when the cause is the environment (a hook, a missing tool, a rule of the repository) and not this task: one sentence every other agent should follow too.',
    '- {"decision":"skip","reason":"..."} when the task is not needed to reach the goal, cannot be done in this project, or is covered by other tasks. The project can still be finished without it.',
    '- {"decision":"ask","reason":"...","options":["...","..."]} only when the answer needs the user: a missing secret or account, a product choice only they can make, or something that would be unsafe to guess. Always include 2 or 3 options: concrete ways forward, each a complete instruction the crew can follow as written, best first. The user picks one.',
    'Read the error first: if it names a rule (a hook, a lint, a permission), the fix is usually to work within it, not to ask. Prefer deciding. Choose ask only when retry and skip would both be wrong.',
  ].join('\n');
}

/**
 * The Lead's check, once the board is finished, of whether the goal is: every planned task accepted does not mean
 * the plan is. A goal that names a multi-phase plan is often planned one phase at a time, so "done" has to be
 * measured against the goal and not against the tasks written so far.
 */
export function coveragePrompt(run: CrewRun): string {
  const board = run.tasks.filter((task) => !task.proposed);
  return [
    'You are the Lead. Every task on the board is now accepted. Check whether the goal itself is finished.',
    'Read the project, and read any plan or specification file the goal names. Do not change any files.',
    '',
    `Goal: ${run.goal}`,
    '',
    'Accepted so far:',
    ...board.filter((task) => task.status === 'accepted').slice(0, 40).map((task) => `- ${task.title}`),
    ...(board.some((task) => task.status === 'skipped') ? ['', 'Skipped:', ...board.filter((task) => task.status === 'skipped').slice(0, 20).map((task) => `- ${task.title}`)] : []),
    '',
    'Reply with only one JSON object:',
    '{"complete":true} when nothing the goal asks for is left undone.',
    '{"complete":false,"remaining":["Phase 1: name", "Phase 2: name"]} when parts of the plan are not built yet, listing each unfinished part in order, named the way the plan names it.',
    'Do not list work that is already accepted. Do not invent work the goal does not ask for.',
  ].join('\n');
}

/** Reads the Lead's coverage check. An unreadable answer means nothing is known to be left, so the run can finish. */
export function parseCoverage(text: string): { remaining: string[] } | null {
  const candidates = [...text.matchAll(/\{[^{}]*"complete"[^{}]*\}|\{[^{}]*\[[^\]]*\][^{}]*"complete"[^{}]*\}|\{[^{}]*"complete"[^{}]*\[[^\]]*\][^{}]*\}/g)].map((match) => match[0]);
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as { complete?: unknown; remaining?: unknown };
      if (typeof value.complete !== 'boolean') continue;
      if (value.complete) return { remaining: [] };
      const remaining = Array.isArray(value.remaining)
        ? value.remaining.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().slice(0, 300)).slice(0, 20)
        : [];
      return { remaining };
    } catch {
      continue;
    }
  }
  return null;
}

/** A question to the Lead from the Chat tab. It answers from the board and the project, and changes nothing. */
export function plainLanguageLines(run: Pick<CrewRun, 'explainSimply'>): string[] {
  return run.explainSimply
    ? ['Write for a developer who is not very technical: short sentences, no jargon. The first time you use a technical term, say what it means in a few plain words. Say what each thing is for, not only its name.']
    : [];
}

export function askPrompt(run: CrewRun, question: string): string {
  const board = run.tasks.filter((task) => !task.proposed);
  const recent = run.feed.slice(-14).map((entry) => `- ${entry.who}: ${entry.text}`);
  const thread = run.chat.slice(-8).map((entry) => `${entry.from === 'you' ? 'The person' : 'You'}: ${entry.text.slice(0, 400)}`);
  return [
    'You are the Lead of a crew. The person who owns this project is asking you a question. Answer it plainly and briefly, in sentences, as you would to a colleague.',
    'Use the board, the recent activity and, where it helps, the project files. Do not change any files and do not start any work.',
    'If the question is really a request to build or change something, say so briefly and tell them to press "Run this as work". Do not lecture and do not ask them to retype it.',
    'You cannot record decisions, approvals or changes from here. Never say that you noted, recorded, approved or changed anything; if they ask you to approve something, say that the Approve button on the crew screen is what records it.',
    ...plainLanguageLines(run),
    '',
    `Goal: ${run.goal}`,
    `Crew status: ${run.status}${run.ask ? `; waiting on the person: ${run.ask.message}` : ''}`,
    boardSummary(run),
    ...(board.length > 0 ? ['', 'Tasks:', ...board.slice(0, 30).map((task) => `- ${task.title} [${task.status}${task.note ? `; ${task.note.slice(0, 120)}` : ''}]`)] : []),
    ...(run.remaining.length > 0 ? ['', `Found still undone: ${run.remaining.join('; ')}`] : []),
    ...(recent.length > 0 ? ['', 'Recent activity:', ...recent] : []),
    ...(thread.length > 0 ? ['', 'This conversation so far:', ...thread] : []),
    '',
    `Question: ${question}`,
  ].join('\n');
}

/**
 * Away mode: the person is not at the computer, so the Lead is asked whether one of the options it offered is safe to
 * take without them. "none" is the right answer whenever the choice is theirs: it keeps the question waiting.
 */
export function awayPrompt(run: CrewRun, task: CrewTask): string {
  const options = run.ask?.options ?? [];
  const history = task.reviews.slice(-3).map((review) => `- ${review.reviewer}, round ${review.round}, ${review.verdict}${review.feedback ? `: ${review.feedback.slice(0, 900)}` : ''}`);
  return [
    'You are the Lead. The person is away from the computer and a task is waiting on a question. They asked the crew to keep going and to leave them a list of what to check when they are back.',
    '',
    `Project goal: ${run.goal}`,
    `Task: ${task.title}`,
    task.description,
    '',
    'Acceptance criteria:',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    `The question: ${run.ask?.message ?? task.note}`,
    ...(history.length > 0 ? ['', 'Recent verdicts:', ...history] : []),
    '',
    ...(options.length > 0
      ? ['Options:', ...options.map((option, index) => `${index + 1}. ${option}`), '', 'Choose the safest option that keeps the work moving.']
      : ['No options were offered. Write the way forward yourself: one complete instruction the builder can follow as written, that keeps the work moving and can be undone later. Where it helps, include checking the result: run the tests, and look at the app in the browser with the playwright tools.']),
    `The person allowed you to: ${allowedWhileAway(run.away.policy ?? DEFAULT_AWAY_POLICY).join('; ') || 'nothing beyond keeping the question for them'}.`,
    `Answer none for anything that needs ${forbiddenWhileAway(run.away.policy ?? DEFAULT_AWAY_POLICY).join(', ')}.`,
    ...((run.away.policy?.other ?? '').trim() ? [`The person's own rule while away, which always holds: ${run.away.policy!.other.trim()}`] : []),
    '',
    'Reply with only one JSON object:',
    ...(options.length > 0
      ? ['{"choice":<option number>,"reason":"...","check":"what the person should look at when they are back"}']
      : ['{"choice":"own","instruction":"...","reason":"...","check":"what the person should look at when they are back"}']),
    'or {"choice":"none","reason":"..."}.',
  ].join('\n');
}

/**
 * Reads the Lead's away-mode answer: an option by number, or (when there were none) its own instruction. "none", an
 * option that does not exist, or anything unreadable keeps the question waiting.
 */
export function parseAwayChoice(text: string, count: number): { index: number; reason: string; check: string; instruction?: string } | { none: true; reason: string } | null {
  const candidates = [...text.matchAll(/\{[^{}]*"choice"[^{}]*\}/g)].map((match) => match[0]);
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as { choice?: unknown; reason?: unknown; check?: unknown; instruction?: unknown };
      const reason = typeof value.reason === 'string' ? value.reason.trim().slice(0, 300) : '';
      const check = typeof value.check === 'string' ? value.check.trim().slice(0, 800) : '';
      // "none" keeps the question for the person, with the Lead's reason so they can see why.
      if (value.choice === 'none') return { none: true, reason };
      if (value.choice === 'own') {
        const instruction = typeof value.instruction === 'string' ? value.instruction.trim().slice(0, 1_200) : '';
        if (count === 0 && instruction) return { index: -1, reason, check, instruction };
        continue;
      }
      const number = typeof value.choice === 'number' ? value.choice : typeof value.choice === 'string' ? Number(value.choice) : NaN;
      if (Number.isInteger(number) && number >= 1 && number <= count) return { index: number - 1, reason, check };
    } catch {
      continue;
    }
  }
  return null;
}

/** Reads the Lead's call on a stuck task. Anything else reads as no decision, so the user is asked. */
export function parseStuckDecision(text: string): { decision: 'retry' | 'skip' | 'ask'; text: string; options?: string[]; lesson?: string } | null {
  const candidates = [...text.matchAll(/\{[^{}]*"decision"[^{}]*\}/g)].map((match) => match[0]);
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as { decision?: unknown; guidance?: unknown; reason?: unknown; options?: unknown; lesson?: unknown };
      const options = Array.isArray(value.options) ? value.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().slice(0, 400)).slice(0, 3) : [];
      const lesson = typeof value.lesson === 'string' ? value.lesson.trim().slice(0, 400) : '';
      const extras = { ...(options.length > 0 ? { options } : {}), ...(lesson ? { lesson } : {}) };
      if (value.decision !== 'retry' && value.decision !== 'skip' && value.decision !== 'ask') continue;
      const words = typeof value.guidance === 'string' && value.guidance.trim() ? value.guidance : typeof value.reason === 'string' ? value.reason : '';
      // A retry with nothing new to say would only fail again, so it is not a usable decision.
      if (value.decision === 'retry' && !words.trim()) continue;
      return { decision: value.decision, text: words.trim(), ...extras };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Reads the Lead's plan. Anything that is not a list of tasks reads as no plan, and the caller asks once more. Task
 * ids are made safe and unique here so a model's repeated or odd ids cannot overwrite each other.
 */
export function parsePlan(text: string): PlannedTask[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const list = (value as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list) || list.length === 0) return null;
  const seen = new Set<string>();
  const planned: PlannedTask[] = [];
  const alias = new Map<string, string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 200) : '';
    const role = typeof item.role === 'string' ? item.role.trim() : '';
    if (!title || !role) continue;
    const base = (typeof item.id === 'string' ? item.id : title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
    let id = base;
    for (let suffix = 2; seen.has(id); suffix += 1) id = `${base}-${suffix}`;
    seen.add(id);
    // When a model reuses an id, a dependency on it means the first task that used it.
    if (typeof item.id === 'string' && !alias.has(item.id)) alias.set(item.id, id);
    planned.push({
      id, title, role,
      description: typeof item.description === 'string' ? item.description.slice(0, 6_000) : '',
      acceptance: Array.isArray(item.acceptance) ? item.acceptance.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim().slice(0, 400)).slice(0, 20) : [],
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.filter((entry): entry is string => typeof entry === 'string') : [],
      designRef: typeof item.designRef === 'string' && item.designRef.trim() ? item.designRef.trim().slice(0, 300) : null,
      phase: typeof item.phase === 'string' && item.phase.trim() ? item.phase.trim().slice(0, 200) : null,
    });
  }
  if (planned.length === 0) return null;
  // Dependencies are written with the ids the model chose; point them at the ids actually used, dropping unknown ones.
  for (const task of planned) task.dependsOn = [...new Set(task.dependsOn.map((id) => alias.get(id) ?? id).filter((id) => seen.has(id) && id !== task.id))];
  return planned;
}

/** What the Lead says needs the person's OK before the crew builds. Never invented: only what the plan reply lists. */
export interface PlanApproval {
  what: string;
  why: string;
}

/** The plan's tasks and the approvals it asks for. A reply with no usable tasks is still no plan at all. */
export function parsePlanFull(text: string): { tasks: PlannedTask[]; approvals: PlanApproval[]; note?: string } | null {
  const tasks = parsePlan(text);
  if (!tasks) {
    // An empty list on purpose, with a reason, is the Lead saying there is nothing left to build; that is an answer, not a failure.
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    if (open < 0 || close <= open) return null;
    try {
      const value = JSON.parse(text.slice(open, close + 1)) as { tasks?: unknown; note?: unknown };
      if (Array.isArray(value.tasks) && value.tasks.length === 0) return { tasks: [], approvals: [], ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim().slice(0, 300) } : {}) };
    } catch {
      return null;
    }
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let list: unknown;
  try { list = (JSON.parse(text.slice(start, end + 1)) as { approvals?: unknown }).approvals; } catch { list = []; }
  const approvals: PlanApproval[] = [];
  if (Array.isArray(list)) {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const what = typeof item.what === 'string' ? item.what.trim().slice(0, 120) : '';
      if (!what || approvals.some((existing) => existing.what.toLowerCase() === what.toLowerCase())) continue;
      approvals.push({ what, why: typeof item.why === 'string' ? item.why.trim().slice(0, 600) : '' });
    }
  }
  return { tasks, approvals: approvals.slice(0, 12) };
}
