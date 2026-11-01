import type { CrewConfig, CrewDesign, CrewRun, CrewTask } from '@kai/contracts';
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

export function planPrompt(goal: string, config: CrewConfig, conventions: string, existing: Pick<CrewRun, 'tasks'>, design: CrewDesign | null = null): string {
  const roles = config.roles.filter((role) => roleAccess(role) === 'edit' || role.kind === 'security' || role.kind === 'reviewer');
  return [
    'You are the Lead of a small crew that will build a project. Read the project, then split the goal into tasks.',
    'Do not change any files. Reply with one JSON object and nothing else.',
    '',
    `Goal: ${goal}`,
    '',
    'Roles that can be given a task (use the id):',
    ...roles.map((role) => `- ${role.id}: ${role.label}${roleAccess(role) === 'edit' ? ' (writes code)' : ' (reviews, read-only)'}`),
    ...(conventions.trim() ? ['', 'How this developer usually builds things (follow these unless the goal says otherwise):', conventions.trim()] : []),
    ...designPlanLines(config, design),
    ...(existing.tasks.length > 0 ? ['', 'The board already has these tasks; add only what is missing:', boardSummary(existing)] : []),
    '',
    'Rules for the tasks:',
    '- Small enough for one agent to finish in one sitting. Prefer 5 to 14 tasks.',
    '- Each task has 1 to 5 acceptance criteria that can be checked by reading the code or running a command.',
    '- "dependsOn" lists task ids that must be accepted first. Use it only where order truly matters.',
    '- Give code tasks to a role that writes code. Never give a task to a read-only role.',
    '',
    'Reply shape:',
    '{"tasks":[{"id":"short-kebab-id","title":"...","role":"builder","description":"...","acceptance":["..."],"dependsOn":[],"designRef":null}]}',
  ].join('\n');
}

export function reviewPrompt(run: CrewRun, task: CrewTask, builderReply: string): string {
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
    '',
    'The builder said:',
    builderReply.trim().slice(-2_500) || '(no reply)',
    '',
    'Reply with one JSON object and nothing else:',
    '{"verdict":"accept"} when every criterion is met,',
    '{"verdict":"sendBack","feedback":"what is wrong, naming the criterion"} when the builder can fix it,',
    '{"verdict":"needsYou","feedback":"the decision only the user can make"} when it cannot be fixed without them.',
  ].join('\n');
}

export function securityPrompt(run: CrewRun, task: CrewTask): string {
  return [
    'You are the security reviewer. Review the code this task changed for secrets in code, missing authentication or authorisation, unsafe input handling, data exposure and risky defaults. Do not change any files.',
    '',
    `Project goal: ${run.goal}`,
    `Task: ${task.title}`,
    ...(task.files.length > 0 ? [`Files changed: ${task.files.slice(0, 40).join(', ')}`] : []),
    '',
    'Reply with one JSON object and nothing else:',
    '{"verdict":"accept"} when there is nothing to fix,',
    '{"verdict":"sendBack","feedback":"the specific problem and where"} for a problem the builder can fix,',
    '{"verdict":"needsYou","feedback":"why this must stop and ask"} for a problem that is serious or needs a decision.',
  ].join('\n');
}

export function retryPrompt(kind: 'plan' | 'review'): string {
  return kind === 'plan'
    ? 'Your previous reply could not be used. Reply again with only the JSON object {"tasks":[...]} and no other text.'
    : 'Your previous reply could not be used. Reply again with only one JSON object such as {"verdict":"accept"} or {"verdict":"sendBack","feedback":"..."}, and no other text.';
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
    });
  }
  if (planned.length === 0) return null;
  // Dependencies are written with the ids the model chose; point them at the ids actually used, dropping unknown ones.
  for (const task of planned) task.dependsOn = [...new Set(task.dependsOn.map((id) => alias.get(id) ?? id).filter((id) => seen.has(id) && id !== task.id))];
  return planned;
}
