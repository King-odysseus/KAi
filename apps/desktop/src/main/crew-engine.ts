import { randomUUID } from 'node:crypto';
import { DEFAULT_AWAY_POLICY, MAX_SUB_AGENTS_TOTAL, buildRoadmap, phaseKey, roleAccess } from '@kai/contracts';
import type { CrewAsk, CrewAwayPolicy, CrewChatEntry, CrewConfig, CrewFeedEntry, CrewReview, CrewRole, CrewRun, CrewTask } from '@kai/contracts';

/**
 * The rules of a Crew run, kept apart from anything that starts an agent so they can be tested without one. Every
 * function takes a run and returns a new one; the service that drives agents decides when to call them.
 */

// The read-only rule and the report are pure, so the Crew screen uses the same ones; they live with the contracts.
export { buildReport, roleAccess } from '@kai/contracts';
export type { CrewReport } from '@kai/contracts';

const FEED_LIMIT = 400;
function feed(run: CrewRun, entry: Omit<CrewFeedEntry, 'id' | 'at'>, at: string): CrewRun {
  const next: CrewFeedEntry = { id: `feed_${randomUUID()}`, at, ...entry };
  return { ...run, feed: [...run.feed, next].slice(-FEED_LIMIT), updatedAt: at };
}

function patchTask(run: CrewRun, taskId: string, change: (task: CrewTask) => CrewTask, at: string): CrewRun {
  return { ...run, updatedAt: at, tasks: run.tasks.map((task) => (task.id === taskId ? { ...change(task), updatedAt: at } : task)) };
}

function taskOf(run: CrewRun, taskId: string): CrewTask {
  const task = run.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`There is no task ${taskId} on this board.`);
  return task;
}

function roleOf(config: CrewConfig, roleId: string): CrewRole | undefined {
  return config.roles.find((role) => role.id === roleId);
}

/** A task is on the board unless a worker only suggested it and nobody has accepted it yet. */
function onBoard(task: CrewTask): boolean {
  return !task.proposed;
}

/** Tasks nothing stands in the way of: waiting, on the board, and every task they depend on already accepted. */
export function readyTasks(run: Pick<CrewRun, 'tasks'>): CrewTask[] {
  const byId = new Map(run.tasks.map((task) => [task.id, task]));
  return run.tasks.filter((task) => {
    if (!onBoard(task) || (task.status !== 'backlog' && task.status !== 'sentBack')) return false;
    // A dependency that is not on the board cannot be waited on: it was removed, so it must not hold the task forever.
    return task.dependsOn.every((id) => {
      const dependency = byId.get(id);
      return !dependency || dependency.status === 'accepted' || dependency.status === 'skipped';
    });
  });
}

/** The tasks to start now: the ready ones that fit under the parallel limit, sent-back work first. */
export function pickTasks(run: CrewRun): CrewTask[] {
  const running = run.tasks.filter((task) => task.status === 'building').length;
  const room = Math.max(0, run.config.limits.maxParallelTasks - running);
  const ready = readyTasks(run);
  return [...ready.filter((task) => task.status === 'sentBack'), ...ready.filter((task) => task.status === 'backlog')].slice(0, room);
}

/**
 * How many helpers a role may start for one task: its own limit, held to what is left of the team-wide cap after the
 * helpers already running.
 */
export function subAgentsFor(config: CrewConfig, roleId: string, activeSubAgents: number): number {
  const role = roleOf(config, roleId);
  if (!role) return 0;
  const teamCap = Math.min(config.limits.maxSubAgents, MAX_SUB_AGENTS_TOTAL);
  return Math.max(0, Math.min(role.subAgents.max, teamCap - activeSubAgents));
}

/** Why the project is not done yet, or null when it is: every task on the board has to be accepted or skipped. */
export function unfinishedReason(run: Pick<CrewRun, 'tasks'>): string | null {
  const proposed = run.tasks.filter((task) => task.proposed).length;
  if (proposed > 0) return `${proposed} suggested ${proposed === 1 ? 'task is' : 'tasks are'} waiting to be accepted.`;
  const open = run.tasks.filter((task) => onBoard(task) && task.status !== 'accepted' && task.status !== 'skipped');
  if (open.length === 0) return run.tasks.length === 0 ? 'The board has no tasks yet.' : null;
  return `${open.length} of ${run.tasks.filter(onBoard).length} tasks are not accepted yet.`;
}

export function isFinished(run: Pick<CrewRun, 'tasks'>): boolean {
  return unfinishedReason(run) === null;
}

/** Adds the tasks the Lead or Planner wrote. A task with no acceptance criteria is refused, with the reason. */
export type CrewTaskDraft = Pick<CrewTask, 'id' | 'title' | 'role' | 'acceptance'> & Partial<CrewTask>;

export function addTasks(run: CrewRun, drafts: readonly CrewTaskDraft[], at: string, by: 'lead' | 'user' = 'lead'): { run: CrewRun; refused: string[] } {
  const refused: string[] = [];
  let next = run;
  for (const draft of drafts) {
    if (!roleOf(run.config, draft.role)) { refused.push(`${draft.title}: there is no role ${draft.role}.`); continue; }
    if (draft.acceptance.length === 0) { refused.push(`${draft.title}: it needs at least one acceptance criterion.`); continue; }
    if (next.tasks.some((task) => task.id === draft.id)) { refused.push(`${draft.title}: a task with id ${draft.id} already exists.`); continue; }
    const task: CrewTask = {
      description: '', dependsOn: [], status: 'backlog', round: 0, reviews: [], designRef: null, proposed: false,
      assignedTo: null, files: [], costUsd: 0, note: '', phase: null, checkpoint: null, ...draft, createdBy: by, updatedAt: at,
    };
    // A task for a role that cannot edit could never be built, so it starts with a role that can.
    const drafted = roleOf(run.config, draft.role);
    const editor = editorRole(run.config);
    if (drafted && editor && roleAccess(drafted) !== 'edit') task.role = editor.id;
    next = { ...next, tasks: [...next.tasks, task], updatedAt: at };
  }
  return { run: next, refused };
}

/**
 * Gives a finished crew more work. The run goes back to planning with the request attached; the Lead then adds tasks
 * to the same board, so the roles, the accepted work and the spend carry on instead of starting from nothing.
 */
export function startFollowUp(run: CrewRun, prompt: string, at: string): CrewRun {
  if (run.status !== 'completed' && run.status !== 'stopped') throw new Error('Only a finished crew can take a follow-up. Use Tell the Lead while it is working.');
  const request = prompt.trim().slice(0, 2_000);
  if (!request) throw new Error('Say what the crew should do next.');
  return feed({ ...run, status: 'planning', followUp: request, ask: null, completedAt: null }, { who: 'you', kind: 'info', text: `Asked for more: ${shorten(request)}` }, at);
}

/**
 * Keeps a follow-up plan from colliding with the board it is added to. The Lead names tasks without seeing every id
 * already used, so one that repeats an existing id gets a number, and the new tasks that depend on it follow.
 */
export function uniqueTaskIds<T extends { id: string; dependsOn?: readonly string[] }>(existing: readonly { id: string }[], drafts: readonly T[]): T[] {
  const taken = new Set(existing.map((task) => task.id));
  const renamed = new Map<string, string>();
  for (const draft of drafts) {
    let id = draft.id;
    for (let n = 2; taken.has(id); n += 1) id = `${draft.id}-${n}`;
    taken.add(id);
    if (id !== draft.id) renamed.set(draft.id, id);
  }
  return drafts.map((draft) => ({
    ...draft,
    id: renamed.get(draft.id) ?? draft.id,
    ...(draft.dependsOn ? { dependsOn: draft.dependsOn.map((dependency) => renamed.get(dependency) ?? dependency) } : {}),
  }));
}

/**
 * Whether a message is only "carry on" ("continue", "next phase", "keep going", "yes"). On a finished crew that means
 * the next unfinished part of the plan, which the crew can find out for itself instead of asking the Lead to guess it
 * from one word.
 */
export function isBareContinue(text: string): boolean {
  const flat = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
  return /^(?:ok(?:ay)?[, ]+)?(?:please )?(?:continue|go on|go ahead|carry on|keep going|proceed|resume|move on|do it|yes|yes please|go|next|next phase|next part|next step|start (?:the )?next(?: phase| part)?)(?: please)?$/.test(flat);
}

/**
 * A question, not a stop: a phase that has spent the amount the person set for one asks whether to carry on, once.
 * Nothing is cut off. With no amount set it never asks.
 */
export function phaseBudgetAsk(run: CrewRun): CrewAsk | null {
  const limit = run.config.phaseBudgetUsd;
  if (!(limit > 0)) return null;
  for (const row of buildRoadmap(run)) {
    if (row.status === 'accepted' || run.phaseSpendOk.includes(row.key)) continue;
    if (row.costUsd >= limit) {
      return { reason: 'phaseSpend', phase: row.key, message: `${row.name} has spent $${row.costUsd.toFixed(2)}, past the $${limit.toFixed(2)} you set for a phase. Carry on?` };
    }
  }
  return null;
}

function askAboutPhaseSpend(run: CrewRun, now: Date): CrewRun {
  const ask = phaseBudgetAsk(run);
  if (!ask) return run;
  const at = now.toISOString();
  return feed({ ...run, status: 'needsYou', ask }, { who: 'crew', kind: 'limit', text: ask.message }, at);
}

/** The phase the crew just finished when the person asked it to stop after that phase, or null when it should carry on. */
export function phaseToPauseAfter(run: Pick<CrewRun, 'tasks' | 'remaining' | 'acceptedPhases' | 'pauseAfter'>): string | null {
  const finished = buildRoadmap(run).filter((row) => row.status === 'done' || row.status === 'accepted');
  const last = finished[finished.length - 1];
  return last && run.pauseAfter.includes(last.key) ? last.name : null;
}

/** Turns "stop after this phase" on or off for one phase. */
export function setPauseAfter(run: CrewRun, phase: string, on: boolean, at: string): CrewRun {
  const key = phaseKey(phase);
  const without = run.pauseAfter.filter((item) => item !== key);
  return { ...run, pauseAfter: on ? [...without, key].slice(-40) : without, updatedAt: at };
}

/** Keeps what reviewers noticed that was not worth stopping a task for, once each, newest 60. */
export function addNotes(run: CrewRun, role: string, taskId: string, notes: readonly string[], at: string): CrewRun {
  const fresh = notes.filter((text) => !run.notes.some((note) => note.taskId === taskId && note.text === text));
  if (fresh.length === 0) return run;
  const added = fresh.map((text, index) => ({ id: `note-${run.notes.length + index + 1}-${taskId}`, at, role, taskId, text: text.slice(0, 600) }));
  return { ...run, notes: [...run.notes, ...added].slice(-60), updatedAt: at };
}

export function clearNotes(run: CrewRun, at: string): CrewRun {
  return run.notes.length === 0 ? run : { ...run, notes: [], updatedAt: at };
}

/** Tasks on the board that are not accepted or skipped: work that is planned and still to be done. */
export function openTasks(run: Pick<CrewRun, 'tasks'>): CrewTask[] {
  return run.tasks.filter((task) => !task.proposed && task.status !== 'accepted' && task.status !== 'skipped');
}

/**
 * Carries on with the tasks already on the board. A crew that was stopped, or interrupted, keeps its unfinished tasks;
 * "continue" means build those, not plan them again. Work that was mid-build has no result to review, so it waits to
 * be built again from the start.
 */
export function reopenOpenTasks(run: CrewRun, summary: string, at: string): CrewRun {
  const tasks = run.tasks.map((task) => (task.status === 'building' || task.status === 'needsYou' ? { ...task, status: 'backlog' as const, updatedAt: at } : task));
  const reopened: CrewRun = { ...run, tasks, status: 'running', ask: null, followUp: null, completedAt: null, updatedAt: at };
  return addChat(feed(reopened, { who: 'crew', kind: 'info', text: summary }, at), { from: 'lead', kind: 'note', text: summary }, at);
}

/** The phase a follow-up asked for ("Continue the plan with: Phase 1: Shell."), so its tasks are filed under it. */
export function phaseFromFollowUp(text: string | null): string | null {
  const match = /Continue the plan with(?: the next unfinished part)?:\s*(.+?)\.(?:\s+Still to do|\s+The person has told|$)/.exec(text ?? '');
  const name = match?.[1]?.trim();
  return name ? name.slice(0, 200) : null;
}

/**
 * Records the person's acceptance of a finished phase. The plan asks for it before the next phase; it is given by a
 * button and kept on the run, so the crew can tell an accepted phase from one that has only been finished.
 */
export function acceptPhase(run: CrewRun, phase: string, at: string): CrewRun {
  const key = phaseKey(phase);
  const row = buildRoadmap(run).find((item) => item.key === key);
  if (!row) throw new Error('That phase is not on this crew\'s plan.');
  if (row.status === 'accepted') return run;
  if (row.status !== 'done') throw new Error(`${row.name} is not finished yet, so it cannot be accepted.`);
  return feed(addChat({ ...run, acceptedPhases: [...run.acceptedPhases, key].slice(-40) }, { from: 'you', kind: 'note', text: `Accepted: ${row.name}` }, at), { who: 'you', kind: 'accepted', text: `Accepted ${row.name}.` }, at);
}

/** Remembers the project as it was before a task first started, so the work can be undone. A task keeps its first one. */
export function setTaskCheckpoint(run: CrewRun, taskId: string, checkpoint: CrewTask['checkpoint'], at: string): CrewRun {
  if (!checkpoint) return run;
  const task = taskOf(run, taskId);
  if (task.checkpoint) return run;
  return patchTask(run, taskId, (item) => ({ ...item, checkpoint }), at);
}

/**
 * The tasks that undoing one would have built again: it, and every task that started after it. Tasks started later
 * carry later checkpoints, so the order they started in is the order of their checkpoints.
 */
export function tasksToRebuild(run: CrewRun, taskId: string): CrewTask[] {
  const task = taskOf(run, taskId);
  if (!task.checkpoint) return [];
  const since = task.checkpoint.createdAt;
  return run.tasks.filter((item) => !item.proposed && item.checkpoint !== null && item.checkpoint.createdAt >= since);
}

/** After the project was put back, the task and every later one wait to be built again from nothing. */
export function resetForRevert(run: CrewRun, taskId: string, summary: string, at: string): CrewRun {
  const rebuild = new Set(tasksToRebuild(run, taskId).map((item) => item.id));
  const tasks = run.tasks.map((item) => (rebuild.has(item.id)
    ? { ...item, status: 'backlog' as const, round: 0, reviews: [], files: [], note: '', checkpoint: null, updatedAt: at }
    : item));
  const accepted = run.acceptedPhases.filter((key) => !tasks.some((item) => item.phase !== null && phaseKey(item.phase) === key && rebuild.has(item.id)));
  const paused: CrewRun = { ...run, tasks, acceptedPhases: accepted, status: 'paused', ask: null, completedAt: null, updatedAt: at };
  return addChat(feed(paused, { who: 'you', kind: 'info', text: summary }, at), { from: 'lead', kind: 'note', text: summary }, at);
}

/** Tells a new crew what earlier crews on this project learned, so it does not meet the same blocker as if it were new. */
export function teachBlockers(run: CrewRun, learned: ReadonlyArray<{ key: string; note: string }>): CrewRun {
  let next = run;
  for (const item of learned) {
    if (next.knownBlockers.includes(item.key)) continue;
    next = withGuidance({ ...next, knownBlockers: [...next.knownBlockers, item.key].slice(-20) }, item.note);
  }
  return next;
}

/** Adds a line to the thread between the person and the Lead. The newest 200 are kept. */
export function addChat(run: CrewRun, entry: { from: 'you' | 'lead'; kind: CrewChatEntry['kind']; text: string }, at: string): CrewRun {
  const next: CrewChatEntry = { id: `chat_${randomUUID()}`, at, from: entry.from, kind: entry.kind, text: entry.text.slice(0, 6_000) };
  return { ...run, chat: [...run.chat, next].slice(-200), updatedAt: at };
}

/** Joins two copies of the thread by id, oldest first, so a line added while another save was in flight is not lost. */
export function mergeChat(a: readonly CrewChatEntry[], b: readonly CrewChatEntry[]): CrewChatEntry[] {
  const byId = new Map<string, CrewChatEntry>();
  for (const entry of [...a, ...b]) byId.set(entry.id, entry);
  return [...byId.values()].sort((x, y) => x.at.localeCompare(y.at)).slice(-200);
}

/**
 * The board finished but the Lead found more of the plan undone, and the person told the crew to keep going: the run
 * goes straight to planning the next part, with what is left attached so the Lead plans only that.
 */
export function continueToNextPhase(run: CrewRun, remaining: readonly string[], at: string): CrewRun {
  const next = remaining[0] ?? 'the rest of the plan';
  const request = `Continue the plan with the next unfinished part: ${next}.${remaining.length > 1 ? ` Still to do after it: ${remaining.slice(1, 8).join('; ')}.` : ''} The person has told the crew to keep going through every phase, so do not wait for their acceptance between phases; stop only where the plan says to stop on a failure.`;
  return feed({ ...run, status: 'planning', followUp: request.slice(0, 2_000), remaining: [...remaining], completedAt: null }, { who: 'crew', kind: 'info', text: `Moving on to: ${shorten(next)}` }, at);
}

/**
 * Puts what the plan says needs the person's OK on the run as cards, and holds the run until each one is answered. The
 * crew never decides these for them. Something already answered (approved or declined) in an earlier phase is not asked again.
 */
export function requestApprovals(run: CrewRun, items: ReadonlyArray<{ what: string; why: string }>, at: string): CrewRun {
  const fresh = items.filter((item) => !run.approvals.some((existing) => existing.what.toLowerCase() === item.what.toLowerCase()));
  if (fresh.length === 0) return run;
  const added = fresh.map((item, index) => ({ id: `approval-${run.approvals.length + index + 1}`, what: item.what, why: item.why, status: 'pending' as const }));
  const approvals = [...run.approvals, ...added].slice(-30);
  const count = added.length;
  const message = `Before it builds, the crew needs your OK on ${count} ${count === 1 ? 'thing' : 'things'}: ${added.map((item) => item.what).join(', ')}.`;
  return feed({ ...run, approvals, status: 'needsYou', ask: { reason: 'approval', message } }, { who: 'crew', kind: 'needsYou', text: message }, at);
}

/**
 * Records the person's yes or no on one approval card. The answer goes to every agent as plain guidance, and the run
 * carries on once no card is waiting. A button records it; a sentence in the chat never does.
 */
export function decideApproval(run: CrewRun, approvalId: string, approve: boolean, at: string): CrewRun {
  const approval = run.approvals.find((item) => item.id === approvalId);
  if (!approval) throw new Error('That approval is no longer on this crew.');
  if (approval.status !== 'pending') return run;
  const approvals = run.approvals.map((item) => (item.id === approvalId ? { ...item, status: approve ? ('approved' as const) : ('declined' as const) } : item));
  const note = approve
    ? `The person approved: ${approval.what}.`
    : `The person did not approve: ${approval.what}. Do not add it; find another way.`;
  let next = addChat(guideCrewRun({ ...run, approvals }, note, at), { from: 'you', kind: 'note', text: approve ? `Approved: ${approval.what}` : `Did not approve: ${approval.what}` }, at);
  const waiting = approvals.some((item) => item.status === 'pending');
  if (!waiting && next.ask?.reason === 'approval') {
    next = feed({ ...next, ask: null, status: 'running' }, { who: 'crew', kind: 'info', text: 'Every approval is answered, so the crew carries on.' }, at);
  }
  return next;
}

/** The role that takes work a read-only role was given: the builder, else any role that may edit files. */
export function editorRole(config: CrewConfig): CrewConfig['roles'][number] | undefined {
  return config.roles.find((role) => role.kind === 'builder') ?? config.roles.find((role) => roleAccess(role) === 'edit');
}

/**
 * Tasks the plan gave to a role that cannot change files (a reviewer, Security) can never be built: every attempt
 * fails the same way, so retrying only burns the send-back limit and then stops the whole run on a mistake the user
 * did not make. They go to the builder instead, and the read-only reviewers still check the result as usual.
 */
export function reassignReadOnlyTasks(run: CrewRun, at: string): CrewRun {
  const editor = editorRole(run.config);
  if (!editor) return run;
  let next = run;
  for (const task of run.tasks) {
    if (task.status !== 'backlog' && task.status !== 'sentBack' && task.status !== 'needsYou') continue;
    const role = roleOf(run.config, task.role);
    if (!role || roleAccess(role) === 'edit') continue;
    const moved = patchTask(next, task.id, (item) => ({
      ...item,
      role: editor.id,
      status: item.status === 'needsYou' ? 'backlog' : item.status,
      note: item.note.startsWith('Build failed') ? '' : item.note,
    }), at);
    next = feed(moved, { who: 'crew', kind: 'info', text: `"${task.title}" was given to ${role.label}, which cannot change files, so ${editor.label} will do it. ${role.label} still reviews the result.`, taskId: task.id }, at);
  }
  return next;
}

/** A worker's suggestion for work the plan missed. It waits off the board until someone accepts it. */
export function proposeTask(run: CrewRun, from: string, draft: CrewTaskDraft, at: string): CrewRun {
  const result = addTasks(run, [{ ...draft, proposed: true }], at, 'lead');
  if (result.refused.length > 0) throw new Error(result.refused[0]);
  const marked = patchTask(result.run, draft.id, (task) => ({ ...task, createdBy: 'worker' }), at);
  return feed(marked, { who: from, kind: 'proposal', text: `Suggested a new task: "${draft.title}".`, taskId: draft.id }, at);
}

export function acceptProposal(run: CrewRun, taskId: string, accepted: boolean, by: string, at: string): CrewRun {
  const task = taskOf(run, taskId);
  if (!task.proposed) return run;
  if (!accepted) return feed({ ...run, tasks: run.tasks.filter((item) => item.id !== taskId), updatedAt: at }, { who: by, kind: 'info', text: `Declined the suggestion "${task.title}".`, taskId }, at);
  return feed(patchTask(run, taskId, (item) => ({ ...item, proposed: false }), at), { who: by, kind: 'info', text: `Added "${task.title}" to the board.`, taskId }, at);
}

/** A builder takes a task. Only a ready task can be taken, and only by a role that exists. */
export function startTask(run: CrewRun, taskId: string, roleId: string, at: string): CrewRun {
  const task = taskOf(run, taskId);
  if (!readyTasks(run).some((item) => item.id === taskId)) throw new Error(`"${task.title}" is not ready to start.`);
  if (!roleOf(run.config, roleId)) throw new Error(`There is no role ${roleId}.`);
  const moved = patchTask(run, taskId, (item) => ({ ...item, status: 'building', round: item.round + 1, assignedTo: roleId }), at);
  return feed(moved, { who: roleId, kind: 'info', text: task.round === 0 ? `Started "${task.title}".` : `Started "${task.title}" again (round ${task.round + 1}).`, taskId }, at);
}

/** The builder hands the task in for review, with the files it changed and what it cost. */
export function submitTask(run: CrewRun, taskId: string, result: { files: readonly string[]; costUsd?: number }, at: string): CrewRun {
  const task = taskOf(run, taskId);
  if (task.status !== 'building') throw new Error(`"${task.title}" is not being built.`);
  const moved = patchTask(run, taskId, (item) => ({
    ...item, status: 'review', files: [...new Set(result.files)].slice(0, 200), costUsd: item.costUsd + (result.costUsd ?? 0),
  }), at);
  return { ...moved, spentUsd: moved.spentUsd + (result.costUsd ?? 0) };
}

/** Two pieces of feedback say the same thing when they match once case, punctuation and spacing are ignored. */
export function sameFeedback(a: string, b: string): boolean {
  const flat = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return flat(a).length > 0 && flat(a) === flat(b);
}

export interface ReviewInput {
  verdict: CrewReview['verdict'];
  feedback: string;
  reviewer: string;
}

/**
 * Records the Lead's verdict. An accept needs every criterion checked, so a task without criteria can never be
 * accepted. A send-back goes to the worker that built the task; once the task has been sent back as often as the
 * limit allows, or for the same reason twice, the run stops and asks the user instead of looping.
 */
export function reviewTask(run: CrewRun, taskId: string, input: ReviewInput, at: string): CrewRun {
  const task = taskOf(run, taskId);
  if (task.status !== 'review') throw new Error(`"${task.title}" is not waiting for review.`);
  if (input.verdict === 'accept' && task.acceptance.length === 0) throw new Error(`"${task.title}" has no acceptance criteria, so there is nothing to accept it against.`);
  const review: CrewReview = { round: task.round, verdict: input.verdict, feedback: input.feedback.trim(), reviewer: input.reviewer, at };

  if (input.verdict === 'accept') {
    const accepted = patchTask(run, taskId, (item) => ({ ...item, status: 'accepted', reviews: [...item.reviews, review] }), at);
    return feed(accepted, { who: input.reviewer, kind: 'accepted', text: `Accepted "${task.title}".`, taskId }, at);
  }

  const previousFeedback = [...task.reviews].reverse().find((item) => item.verdict === 'sendBack')?.feedback ?? '';
  const sendBacks = task.reviews.filter((item) => item.verdict === 'sendBack').length + (input.verdict === 'sendBack' ? 1 : 0);
  const repeated = run.config.savings.stopOnRepeatedFailure && input.verdict === 'sendBack' && sameFeedback(previousFeedback, input.feedback);
  const exhausted = sendBacks > run.config.limits.maxSendBacks;
  const escalate = input.verdict === 'needsYou' || repeated || exhausted;

  const withReview = patchTask(run, taskId, (item) => ({ ...item, status: escalate ? 'needsYou' : 'sentBack', reviews: [...item.reviews, review] }), at);
  if (!escalate) return feed(withReview, { who: input.reviewer, kind: 'sentBack', text: `Sent "${task.title}" back: ${shorten(input.feedback)}`, taskId }, at);

  const ask: CrewAsk = {
    reason: repeated ? 'sameFailure' : exhausted ? 'sendBacks' : roleOf(run.config, input.reviewer)?.kind === 'security' ? 'securityBlock' : 'noProgress',
    message: repeated
      ? `"${task.title}" came back for the same problem twice: ${shorten(input.feedback)}`
      : exhausted
        ? `"${task.title}" has been sent back ${sendBacks - 1} times. ${shorten(input.feedback)}`
        // A question for the person is shown whole: cut short, it hid what they were being asked to decide.
        : `${input.reviewer} needs you on "${task.title}": ${shorten(input.feedback, 900)}`,
    taskId,
  };
  return feed({ ...withReview, status: 'needsYou', ask }, { who: input.reviewer, kind: 'needsYou', text: ask.message, taskId }, at);
}

function shorten(text: string, length = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * What the user chose when the run asked. "continue" gives a stuck task one more round (or lets the run go on past a
 * limit); "skip" drops the task from the finish line; "finish" ends the run with what is accepted.
 */
export function answerAsk(run: CrewRun, answer: 'continue' | 'skip' | 'finish', guidance: string, at: string): CrewRun {
  const ask = run.ask;
  if (!ask) return run;
  let next: CrewRun = { ...run, ask: null, updatedAt: at };
  const taskId = ask.taskId;
  if (answer === 'finish') {
    return feed({ ...next, status: 'stopped', completedAt: at }, { who: 'you', kind: 'info', text: 'Finished the run with the work accepted so far.' }, at);
  }
  if (taskId && answer === 'skip') {
    next = patchTask(next, taskId, (task) => ({ ...task, status: 'skipped', note: 'Skipped by you.' }), at);
    next = feed(next, { who: 'you', kind: 'info', text: 'Skipped the task.', taskId }, at);
  } else if (taskId) {
    next = patchTask(next, taskId, (task) => ({
      ...task, status: 'sentBack',
      // Guidance becomes the next piece of feedback, and the send-back count starts again from here.
      reviews: [...task.reviews.filter((item) => item.verdict !== 'sendBack'), ...(guidance.trim() ? [{ round: task.round, verdict: 'sendBack' as const, feedback: guidance.trim(), reviewer: 'you', at }] : [])],
    }), at);
    next = feed(next, { who: 'you', kind: 'info', text: guidance.trim() ? `Gave guidance: ${shorten(guidance)}` : 'Asked for another round.', taskId }, at);
  } else {
    // Continuing past a limit moves the limit out by the same amount again, so the next question comes later, not now.
    const limits = { ...next.config.limits };
    if (ask.reason === 'spend' && limits.maxUsd > 0) limits.maxUsd = Math.max(limits.maxUsd * 2, next.spentUsd + limits.maxUsd);
    if (ask.reason === 'time' && limits.maxMinutes > 0) limits.maxMinutes *= 2;
    // A phase's spend question is asked once: the answer is remembered for that phase.
    const phaseSpendOk = ask.reason === 'phaseSpend' && ask.phase ? [...next.phaseSpendOk, ask.phase].slice(-40) : next.phaseSpendOk;
    next = feed({ ...next, phaseSpendOk, config: { ...next.config, limits } }, { who: 'you', kind: 'info', text: ask.reason === 'phaseSpend' ? 'Carried on past the phase budget.' : 'Continued past the limit.' }, at);
  }
  return { ...next, status: 'running' };
}

/**
 * The task the run stopped on because it ran out of retries, when that is something the Lead can settle: a build that
 * kept failing, or work sent back too often or for the same reason twice. A security block, or a reviewer saying a
 * choice is the user's, is never settled for them.
 */
export function stuckTask(run: CrewRun): CrewTask | null {
  const ask = run.ask;
  if (run.status !== 'needsYou' || !ask?.taskId) return null;
  const task = run.tasks.find((item) => item.id === ask.taskId);
  if (!task || task.status !== 'needsYou') return null;
  const exhausted = ask.reason === 'sendBacks' || ask.reason === 'sameFailure' || (ask.reason === 'noProgress' && task.note.startsWith('Build failed'));
  return exhausted ? task : null;
}

/**
 * Applies the Lead's call on a stuck task: retry with its guidance (the failure count starts again), or skip it so the
 * rest of the project can finish. Returns null for "ask", leaving the question with the user.
 */
export function resolveStuck(run: CrewRun, decision: { decision: 'retry' | 'skip' | 'ask'; text: string; options?: string[]; lesson?: string }, leadId: string, at: string): CrewRun | null {
  const task = stuckTask(run);
  if (!task || decision.decision === 'ask') return null;
  // A cause in the environment, not the task, is told to every agent so the next task does not hit it too.
  const learned = decision.decision === 'retry' && decision.lesson ? withGuidance(run, decision.lesson) : run;
  const cleared: CrewRun = { ...learned, ask: null, status: 'running', updatedAt: at };
  if (decision.decision === 'skip') {
    const skipped = patchTask(cleared, task.id, (item) => ({ ...item, status: 'skipped', note: 'Skipped by the Lead.' }), at);
    return feed(skipped, { who: leadId, kind: 'info', text: `Skipped "${task.title}" and went on without it${decision.text ? `: ${shorten(decision.text)}` : '.'}`, taskId: task.id }, at);
  }
  const retried = patchTask(cleared, task.id, (item) => ({
    ...item, status: 'sentBack', note: '',
    reviews: [...item.reviews.filter((review) => review.verdict !== 'sendBack'), { round: item.round, verdict: 'sendBack' as const, feedback: decision.text, reviewer: leadId, at }],
  }), at);
  return feed(retried, { who: leadId, kind: 'info', text: `Tried "${task.title}" a different way: ${shorten(decision.text)}`, taskId: task.id }, at);
}

/**
 * The Lead could not settle a stuck task alone: its reason and the ways forward it worked out go on the question, so the
 * person picks one instead of writing the fix. With no usable options the question stays as it was.
 */
export function offerOptions(run: CrewRun, decision: { text: string; options?: string[] } | null): CrewRun {
  if (!run.ask || !decision) return run;
  const options = decision.options ?? [];
  if (options.length === 0 && !decision.text) return run;
  const reason = decision.text ? ` The Lead's view: ${decision.text}` : '';
  const message = `${run.ask.message.slice(0, 900)}${reason}`.slice(0, 1_400);
  return { ...run, ask: { ...run.ask, message, ...(options.length > 0 ? { options } : {}) } };
}

/** The most automatic choices away mode makes on one task, and in one run, so a bad pick cannot snowball. */
export const AWAY_MAX_PER_TASK = 2;
export const AWAY_MAX_PER_RUN = 10;

/**
 * The stuck task away mode may settle, or null. Only a question about one task qualifies, with the Lead's options or
 * without them (then the Lead writes its own reversible way forward). Security blocks, approvals, limits and an agent
 * out of usage never reach here: those wait for the person.
 */
export function awayEligible(run: CrewRun): CrewTask | null {
  const ask = run.ask;
  const policy = run.away.policy ?? DEFAULT_AWAY_POLICY;
  // A parked question (the crew carries on with other tasks meanwhile) leaves the run running, and still counts.
  if (!run.away.enabled || (run.status !== 'needsYou' && run.status !== 'running') || !ask?.taskId) return null;
  // What the person allowed decides which questions the Lead may answer: a stuck task needs at least one way it may act,
  // and a security finding only when they allowed security changes.
  const stuckKinds = ask.reason === 'sendBacks' || ask.reason === 'sameFailure' || ask.reason === 'noProgress';
  if (stuckKinds && !(policy.retry || policy.skip || policy.reversible)) return null;
  if (!stuckKinds && !(ask.reason === 'securityBlock' && policy.security)) return null;
  const task = run.tasks.find((item) => item.id === ask.taskId);
  if (!task || task.status !== 'needsYou' || task.note.startsWith('Usage limit')) return null;
  if (run.away.picked.length >= AWAY_MAX_PER_RUN || run.away.picked.filter((id) => id === task.id).length >= AWAY_MAX_PER_TASK) return null;
  return task;
}

/**
 * Turns away mode on or off. What was chosen so far is kept, so the ceilings hold across switches. Turning it off after
 * a stretch away posts a short summary of that stretch, written from the run's own records.
 */
export function setAway(run: CrewRun, enabled: boolean, minutes: number, at: string, policy?: CrewAwayPolicy): CrewRun {
  // Changing only the rules is not switching away mode on or off: no note, no summary.
  if (policy && enabled === run.away.enabled && minutes === run.away.minutes) return setAwayPolicy(run, policy, at);
  if (policy) run = setAwayPolicy(run, policy, at);
  const wasOn = run.away.enabled;
  const since = enabled ? (wasOn ? run.away.since ?? at : at) : null;
  const text = enabled
    ? (minutes > 0 ? `Away mode is on. If a stuck task waits ${minutes} minutes for you, the Lead takes the safest of its own options.` : 'Away mode is on. The Lead takes the safest of its own options as soon as a task is stuck.')
    : 'Away mode is off. The crew waits for you on every question.';
  const next = addChat({ ...run, away: { ...run.away, enabled, minutes, since }, updatedAt: at }, { from: 'lead', kind: 'note', text }, at);
  return !enabled && wasOn && run.away.since ? addChat(next, { from: 'lead', kind: 'note', text: awaySummary(run, run.away.since) }, at) : next;
}

/** What happened while the person was away, from the feed and the decisions, never from a model: nothing in it can be made up. */
export function awaySummary(run: CrewRun, since: string): string {
  const after = (at: string): boolean => at >= since;
  const accepted = run.feed.filter((entry) => entry.kind === 'accepted' && after(entry.at)).map((entry) => entry.text.replace(/^Accepted /, '').replace(/\.$/, ''));
  const decided = (run.away.decisions ?? []).filter((item) => after(item.at));
  const waiting = [run.ask, ...run.queuedAsks].filter((ask): ask is CrewAsk => Boolean(ask));
  const lines = [
    `While you were away: ${accepted.length} ${accepted.length === 1 ? 'task' : 'tasks'} accepted${accepted.length > 0 ? ` (${shorten(accepted.join(', '), 400)})` : ''}.`,
    ...(decided.length > 0 ? [`The Lead decided ${decided.length} ${decided.length === 1 ? 'question' : 'questions'} for you. Check these:`, ...decided.map((item) => `- "${item.task}": ${shorten(item.choice, 200)}${item.check ? ` Check: ${shorten(item.check, 200)}` : ''}`)] : ['The Lead did not decide anything for you.']),
    ...(waiting.length > 0 ? [`Still waiting on you: ${waiting.length} ${waiting.length === 1 ? 'question' : 'questions'}.`, ...waiting.map((ask) => `- ${shorten(ask.message, 200)}`)] : ['Nothing is waiting on you.']),
  ];
  return lines.join('\n');
}

/** A question about one task can wait while the crew works on the others; limits and approvals hold the whole run. */
export function parkableAsk(ask: CrewAsk | null | undefined): boolean {
  return Boolean(ask?.taskId) && ask!.reason !== 'approval' && ask!.reason !== 'spend' && ask!.reason !== 'time' && ask!.reason !== 'phaseSpend';
}

/**
 * The crew stopped on a question about one task, but other tasks can still be built: the question stays open for the
 * person and the run carries on with the rest, instead of standing idle until they answer. Returns null when nothing
 * else can go ahead (every other task is done or depends on the waiting one).
 */
export function parkAsk(run: CrewRun, at: string): CrewRun | null {
  if (run.status !== 'needsYou' || !parkableAsk(run.ask)) return null;
  const others = readyTasks(run).length + run.tasks.filter((task) => task.status === 'review').length;
  if (others === 0) return null;
  const title = run.tasks.find((task) => task.id === run.ask!.taskId)?.title ?? 'One task';
  return feed({ ...run, status: 'running', updatedAt: at }, { who: 'crew', kind: 'info', text: `"${title}" waits for your answer. The crew carries on with the other tasks meanwhile; anything that depends on it waits too.`, taskId: run.ask!.taskId }, at);
}

/**
 * Keeps every open question: a new question about another task, raised while one was parked, puts the older one in a
 * queue instead of over it; once the current question is answered, the next one still open comes up.
 */
export function queueAsks(previous: CrewRun, next: CrewRun): CrewRun {
  let run = next;
  const old = previous.ask;
  const stillWaiting = (ask: CrewAsk): boolean => run.tasks.find((task) => task.id === ask.taskId)?.status === 'needsYou';
  if (old?.taskId && run.ask && run.ask.taskId !== old.taskId && stillWaiting(old) && !run.queuedAsks.some((ask) => ask.taskId === old.taskId)) {
    run = { ...run, queuedAsks: [...run.queuedAsks, old].slice(-20) };
  }
  if (!run.ask && run.queuedAsks.length > 0 && run.status !== 'stopped' && run.status !== 'completed') {
    const open = run.queuedAsks.filter(stillWaiting);
    const [first, ...rest] = open;
    run = first ? { ...run, ask: first, queuedAsks: rest, status: run.status === 'running' ? 'needsYou' : run.status } : { ...run, queuedAsks: [] };
  }
  return run;
}

/**
 * The most one task may cost before the crew stops and asks: three times a usual accepted task, and at least a dollar,
 * once three tasks give a usual cost to go by. Each time it was already asked about, the ceiling moves out again.
 */
export function taskBudget(run: CrewRun, task: CrewTask): number | null {
  const paid = run.tasks.filter((item) => !item.proposed && item.status === 'accepted' && item.costUsd > 0);
  if (paid.length < 3) return null;
  const usual = paid.reduce((sum, item) => sum + item.costUsd, 0) / paid.length;
  const step = Math.max(1, usual * 3);
  // After a "carry on", the next stop is a full step past what the task had cost by then: raising the ceiling by a
  // multiple left a task already past it asking again at once, three times in a row.
  const entries = run.spendAsked.filter((entry) => entry.split('@')[0] === task.id);
  const costed = entries.filter((entry) => entry.includes('@')).map((entry) => Number(entry.split('@')[1])).filter((cost) => Number.isFinite(cost));
  if (costed.length > 0) return Math.max(...costed) + step;
  // Records from before the cost was kept say only that it was asked: each one moves the ceiling out a step. Reading
  // them as $0 put the ceiling back at one step and asked again at once.
  return step * (entries.length + 1);
}

/** Stops one task that has cost far more than usual, with a question; the rest of the crew can carry on meanwhile. */
export function askTaskSpend(run: CrewRun, taskId: string, at: string): CrewRun | null {
  // The person turned the costly-task stop off: tasks never stop for what they cost.
  if (!(run.away.policy ?? DEFAULT_AWAY_POLICY).costCheck) return null;
  const task = run.tasks.find((item) => item.id === taskId);
  const budget = task ? taskBudget(run, task) : null;
  if (!task || budget === null || task.costUsd <= budget) return null;
  const paid = run.tasks.filter((item) => !item.proposed && item.status === 'accepted' && item.costUsd > 0);
  const usual = paid.reduce((sum, item) => sum + item.costUsd, 0) / paid.length;
  const awayPolicy = run.away.policy ?? DEFAULT_AWAY_POLICY;
  const pastAwayLimit = run.away.enabled && awayPolicy.costly && awayPolicy.costlyMaxUsd > 0 && task.costUsd >= awayPolicy.costlyMaxUsd;
  const ask: CrewAsk = {
    reason: 'taskSpend',
    message: `"${task.title}" has cost $${task.costUsd.toFixed(2)} over ${task.round} ${task.round === 1 ? 'round' : 'rounds'}, more than three times a usual task ($${usual.toFixed(2)}).${pastAwayLimit ? ` That is past the $${awayPolicy.costlyMaxUsd.toFixed(2)} you allowed per task while away, so it waits for you.` : ''} Continue gives it another round, your words steer it, Skip task drops it.`,
    taskId,
  };
  const marked = { ...run, spendAsked: [...run.spendAsked, `${taskId}@${task.costUsd.toFixed(2)}`].slice(-200) };
  // Away, with the person's say-so: another round is allowed while the task stays under their per-task limit.
  const policy = run.away.policy ?? DEFAULT_AWAY_POLICY;
  if (run.away.enabled && policy.costly && (policy.costlyMaxUsd === 0 || task.costUsd < policy.costlyMaxUsd)) {
    const limit = policy.costlyMaxUsd === 0 ? 'you set no limit per task' : `under your $${policy.costlyMaxUsd.toFixed(2)} limit per task`;
    return recordAwayDecision(marked, taskId, ask.message, `Let it carry on for another round ($${task.costUsd.toFixed(2)} so far, ${limit}).`, '', `Whether "${task.title}" was worth what it cost.`, at);
  }
  const stopped = patchTask(marked, taskId, (item) => ({ ...item, status: 'needsYou' }), at);
  return feed({ ...stopped, status: 'needsYou', ask }, { who: 'crew', kind: 'needsYou', text: ask.message, taskId }, at);
}

/**
 * The Lead's pick, applied as the answer to the question, and recorded so the person can see it on return: in the
 * chat now, and in the report with what the Lead says they should check.
 */
export function applyAwayPick(run: CrewRun, option: string, reason: string, at: string, check = ''): CrewRun {
  const taskId = run.ask?.taskId;
  if (!taskId) return run;
  const question = run.ask?.message ?? '';
  const answered = answerAsk(run, 'continue', option, at);
  return recordAwayDecision(answered, taskId, question, option, reason, check, at);
}

/**
 * Writes down a decision taken for the person while they were away, so it is in the chat now and in the report and the
 * summary later: the question, the choice, and what they should check.
 */
export function recordAwayDecision(run: CrewRun, taskId: string, question: string, choice: string, reason: string, check: string, at: string): CrewRun {
  const title = run.tasks.find((task) => task.id === taskId)?.title ?? taskId;
  const text = `Chose automatically while you were away: ${shorten(choice)}${reason ? ` (${shorten(reason)})` : ''}${check ? ` Check when you are back: ${shorten(check)}` : ''}`;
  const decision = { at, taskId, task: title.slice(0, 300), question: question.slice(0, 1_200), choice: choice.slice(0, 1_200), check: check.slice(0, 800) };
  const next = { ...run, away: { ...run.away, picked: [...run.away.picked, taskId].slice(-40), decisions: [...(run.away.decisions ?? []), decision].slice(-40) } };
  return addChat(feed(next, { who: 'lead', kind: 'info', text, taskId }, at), { from: 'lead', kind: 'note', text }, at);
}

/** Sets what the Lead may decide alone while the person is away. */
export function setAwayPolicy(run: CrewRun, policy: CrewAwayPolicy, at: string): CrewRun {
  return { ...run, away: { ...run.away, policy }, updatedAt: at };
}

/**
 * A build failed the same way twice: the Lead is asked now, not after the retries are spent. A usable answer redirects
 * the task without using a retry (skip, or a different instruction with an optional lesson for every agent), or
 * raises the question at once when the Lead has options for the person. Anything else returns null and the crew carries on.
 */
export function applyTriage(run: CrewRun, taskId: string, decision: { decision: 'retry' | 'skip' | 'ask'; text: string; options?: string[]; lesson?: string } | null, leadId: string, at: string): CrewRun | null {
  const task = run.tasks.find((item) => item.id === taskId);
  if (!task || !decision || task.status !== 'backlog') return null;
  if (decision.decision === 'skip') {
    return feed(patchTask(run, taskId, (item) => ({ ...item, status: 'skipped', note: 'Skipped by the Lead.' }), at), { who: leadId, kind: 'info', text: `Skipped "${task.title}" after it failed twice the same way${decision.text ? `: ${shorten(decision.text)}` : '.'}`, taskId }, at);
  }
  if (decision.decision === 'retry') {
    const learned = decision.lesson ? withGuidance(run, decision.lesson) : run;
    const redirected = patchTask(learned, taskId, (item) => ({
      ...item, status: 'sentBack', note: '',
      reviews: [...item.reviews.filter((review) => review.verdict !== 'sendBack'), { round: item.round, verdict: 'sendBack' as const, feedback: decision.text, reviewer: leadId, at }],
    }), at);
    return feed(redirected, { who: leadId, kind: 'info', text: `"${task.title}" failed the same way twice, so the Lead redirected it: ${shorten(decision.text)}`, taskId }, at);
  }
  if (!decision.options?.length) return null;
  const ask: CrewAsk = { reason: 'sameFailure', message: `"${task.title}" failed the same way twice: ${shorten(task.note.replace(/^Build failed \(\d+\):\s*/, ''))}`, taskId };
  const stopped = feed({ ...patchTask(run, taskId, (item) => ({ ...item, status: 'needsYou' }), at), status: 'needsYou', ask }, { who: 'crew', kind: 'needsYou', text: ask.message, taskId }, at);
  return offerOptions(stopped, decision);
}

/** Whether a failure repeats the one before it: the same cause twice, which a plain retry will not fix. */
export function repeatsFailure(previousNote: string, error: string): boolean {
  if (!previousNote.startsWith('Build failed')) return false;
  const fingerprint = cleanError(error).toLowerCase().slice(0, 40);
  return fingerprint.length > 0 && previousNote.toLowerCase().includes(fingerprint);
}

/** Adds fresh project guidance to a live run without requiring the crew to be stopped on an Ask. */
export function guideCrewRun(run: CrewRun, guidance: string, at: string): CrewRun {
  const note = guidance.trim().slice(0, 2_000);
  if (!note) return run;
  const heading = '\n\nNew guidance from you:\n';
  const goal = `${run.goal.slice(0, Math.max(0, 4_000 - heading.length - note.length))}${heading}${note}`;
  return feed({ ...run, goal, updatedAt: at }, { who: 'you', kind: 'info', text: `Told the Lead: ${shorten(note)}` }, at);
}

/** A limit that has been reached, as a question for the user, or null while the run is inside all of them. */
export function limitReached(run: CrewRun, now: Date): CrewAsk | null {
  const { maxUsd, maxMinutes } = run.config.limits;
  if (maxUsd > 0 && run.spentUsd >= maxUsd) {
    return { reason: 'spend', message: `The run has spent $${run.spentUsd.toFixed(2)} of the $${maxUsd.toFixed(2)} you allowed.` };
  }
  if (maxMinutes > 0 && (now.getTime() - new Date(run.startedAt).getTime()) / 60_000 >= maxMinutes) {
    return { reason: 'time', message: `The run has used the ${maxMinutes} minutes you allowed.` };
  }
  return null;
}

/** Stops the run on a limit and asks, or finishes quietly when the user chose that. Nothing is cut off mid-task. */
export function enforceLimits(run: CrewRun, now: Date): CrewRun {
  if (run.status !== 'running' || run.ask) return run;
  const ask = limitReached(run, now);
  if (!ask) return askAboutPhaseSpend(run, now);
  const at = now.toISOString();
  if (run.config.limits.onLimit === 'finish') {
    return feed({ ...run, status: 'stopped', completedAt: at }, { who: 'crew', kind: 'limit', text: `${ask.message} Finished with the accepted work.` }, at);
  }
  return feed({ ...run, status: 'needsYou', ask }, { who: 'crew', kind: 'limit', text: ask.message }, at);
}

/**
 * Decides where the run stands after a change: finished when the board says so (and the check, if there is one,
 * has passed), waiting on the user while a question is open, otherwise running.
 */
export function settle(run: CrewRun, at: string, check?: { passed: boolean }): CrewRun {
  if (run.status === 'stopped' || run.status === 'completed') return run;
  if (run.ask || run.tasks.some((task) => task.status === 'needsYou')) return { ...run, status: 'needsYou', updatedAt: at };
  if (isFinished(run)) {
    if (run.config.checkCommand && !check?.passed) return { ...run, status: 'running', updatedAt: at };
    // Done means the planned tasks are accepted. When the Lead found more of the plan undone, it says so, so the
    // finish line never claims a project that is only partly built.
    const text = run.remaining.length > 0
      ? `All planned tasks are accepted. Not finished yet: ${shorten(run.remaining.join('; '), 240)}`
      : 'Every task is accepted. The project is done.';
    return feed({ ...run, status: 'completed', completedAt: at }, { who: 'crew', kind: 'done', text }, at);
  }
  return { ...run, status: run.status === 'planning' || run.status === 'awaitingApproval' ? run.status : 'running', updatedAt: at };
}

/** A line per task state for the brief every agent receives, so none of them needs the chat history. */
export function boardSummary(run: Pick<CrewRun, 'tasks'>): string {
  const count = (status: CrewTask['status']): number => run.tasks.filter((task) => onBoard(task) && task.status === status).length;
  const open = run.tasks.filter((task) => onBoard(task) && task.status !== 'accepted' && task.status !== 'skipped');
  return [
    `Board: ${count('accepted')} accepted, ${count('review')} in review, ${count('building')} being built, ${count('sentBack')} sent back, ${count('backlog')} waiting, ${count('needsYou')} waiting on the user.`,
    ...open.slice(0, 12).map((task) => `- ${task.title} [${task.status}]`),
    ...(open.length > 12 ? [`- and ${open.length - 12} more`] : []),
  ].join('\n');
}

/**
 * The brief a worker gets: its task, the criteria, the Lead's latest feedback and the state of the board. It is the
 * same whether or not a model wrote any of it, which is why it costs a few hundred tokens instead of a history.
 */
export function taskBrief(run: CrewRun, taskId: string, conventions = ''): string {
  const task = taskOf(run, taskId);
  const role = roleOf(run.config, task.role);
  const feedback = [...task.reviews].reverse().find((item) => item.verdict === 'sendBack');
  const writes = role && roleAccess(role) === 'edit';
  return [
    `Project goal: ${run.goal}`,
    '',
    `Your task: ${task.title}`,
    task.description,
    ...(task.note ? ['', `Task note from the previous attempt: ${task.note}`] : []),
    '',
    'Acceptance criteria (the Lead will check each one):',
    ...task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
    ...(feedback ? ['', `The Lead sent this back (round ${feedback.round}). Fix exactly this:`, feedback.feedback] : []),
    ...(task.designRef ? ['', `This task builds the design page ${task.designRef}. Match it.`] : []),
    ...(conventions.trim() ? ['', 'How this developer usually builds things:', conventions.trim()] : []),
    '',
    boardSummary(run),
    '',
    writes ? 'You may change files. Keep the change to this task, run the relevant checks, and report the files you changed.' : 'Do not change any files. Report what you found.',
    'For anything that shows on screen, check it yourself in the running app with the browser tools (the playwright tools) rather than asking the person to look.',
    ...(writes && !run.config.commitWork ? ['Do not run git commit or git push, and do not stage files. Leave your changes uncommitted: the person reviews them and commits when the phase is done.'] : []),
  ].join('\n');
}

/** The composer's helper choices, as total agents. A role's sub-agents are helpers on top of the one that runs. */
const HELPER_TOTALS = [2, 3, 4, 5, 6, 8] as const;

/** The composer setting for a run that may use this many sub-agents: off for none, else the next size up that fits. */
export function helperChoiceFor(subAgents: number): 'off' | '2' | '3' | '4' | '5' | '6' | '8' {
  if (subAgents <= 0) return 'off';
  const total = subAgents + 1;
  const fit = HELPER_TOTALS.find((size) => size >= total) ?? 8;
  return String(fit) as '2' | '3' | '4' | '5' | '6' | '8';
}

/** Adds what a review cost to the task and the run, so the spend limit sees reviewers as well as builders. */
export function addSpend(run: CrewRun, taskId: string, costUsd: number, at: string): CrewRun {
  if (!(costUsd > 0)) return run;
  const moved = patchTask(run, taskId, (task) => ({ ...task, costUsd: task.costUsd + costUsd }), at);
  return { ...moved, spentUsd: moved.spentUsd + costUsd };
}

/**
 * A build that failed outright (the agent errored, not the review). The task goes back to waiting so the next pass
 * tries it again, but a task that keeps failing is the user's to decide, so it stops at the send-back limit.
 */
export function failBuild(run: CrewRun, taskId: string, error: string, at: string): CrewRun {
  const task = taskOf(run, taskId);
  // An agent that has run out of subscription or credit fails the same way every time, so retrying only wastes the
  // retries. The crew asks once, in words that say what to change, and does not hand it to the Lead to decide.
  if (isUsageLimit(error)) {
    const role = task.assignedTo ? roleOf(run.config, task.assignedTo) : undefined;
    const who = role ? `${role.label} (${role.agent})` : 'The agent';
    const note = `Usage limit: ${shorten(error, 200)}`;
    const ask: CrewAsk = {
      reason: 'noProgress',
      message: `${who} has run out of usage and could not build "${task.title}". Change that role's agent or model in the Crew tab, save, then press Continue. (${shorten(error, 120)})`,
      taskId,
    };
    return feed({ ...patchTask(run, taskId, (item) => ({ ...item, status: 'needsYou', note }), at), status: 'needsYou', ask }, { who: 'crew', kind: 'needsYou', text: ask.message, taskId }, at);
  }
  // The connection to the agent's provider was cut ("terminated"): nothing about the work went wrong, so it is retried
  // without counting as a failed attempt, up to three times in a row.
  if (isConnectionDrop(error)) {
    const drops = task.note.startsWith('Connection dropped') ? Number(task.note.match(/\((\d+)\)/)?.[1] ?? 1) + 1 : 1;
    if (drops <= MAX_CONNECTION_DROPS) {
      const note = `Connection dropped (${drops}): ${shorten(error, 200)}`;
      return feed(patchTask(run, taskId, (item) => ({ ...item, status: 'backlog', note }), at), { who: task.assignedTo ?? 'builder', kind: 'info', text: `The connection to the agent was cut while it built "${task.title}" (${shorten(cleanError(error), 80)}). That is the provider or the network, not the work, so it is tried again without counting as a failure (${drops} of ${MAX_CONNECTION_DROPS}).`, taskId }, at);
    }
  }
  const failures = task.note.startsWith('Build failed') ? Number(task.note.match(/\((\d+)\)/)?.[1] ?? 1) + 1 : 1;
  const stuck = failures > run.config.limits.maxSendBacks;
  const note = `Build failed (${failures}): ${shorten(error, 200)}`;
  if (!stuck) {
    return feed(patchTask(run, taskId, (item) => ({ ...item, status: 'backlog', note }), at), { who: task.assignedTo ?? 'builder', kind: 'info', text: `"${task.title}" failed to build and will be tried again: ${shorten(error)}`, taskId }, at);
  }
  const ask: CrewAsk = { reason: 'noProgress', message: `"${task.title}" failed to build ${failures} times: ${shorten(error)}`, taskId };
  return feed({ ...patchTask(run, taskId, (item) => ({ ...item, status: 'needsYou', note }), at), status: 'needsYou', ask }, { who: 'crew', kind: 'needsYou', text: ask.message, taskId }, at);
}

/** Dropped connections in a row that are retried for free before they count as failures. */
export const MAX_CONNECTION_DROPS = 3;

/** Whether an agent's failure is its connection being cut (a stream ended early), rather than the work going wrong. */
export function isConnectionDrop(error: string): boolean {
  return /^\s*(?:TypeError:\s*)?terminated\s*$|ECONNRESET|socket hang up|other side closed|UND_ERR_SOCKET|fetch failed|network connection was lost|stream (?:was )?(?:closed|ended) (?:unexpectedly|early)/i.test(cleanError(error));
}

/**
 * Every top-level {...} in a reply, found by matching braces outside strings. A pattern that forbids braces inside the
 * object missed any verdict whose feedback quoted code ("{}", "${x}"), and the reply was then read as unreadable.
 */
export function jsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { if (depth > 0) inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue; }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { found.push(text.slice(start, index + 1)); start = -1; }
    }
  }
  return found;
}

/** Whether an agent's failure says its usage, credit or subscription is spent, rather than that the work went wrong. */
export function isUsageLimit(error: string): boolean {
  return /usage limit|rate limit|quota|out of (credits|usage)|credit balance|limit (has been |was )?reached|too many requests|(?:http|status|error|code)[ :]*429|plan limit|insufficient (credit|balance|quota)|subscription (limit|expired)|reached your .{0,24}limit/i.test(error);
}

/**
 * An error as a person can read it: terminal colour codes, and the bracket text they leave behind when the escape
 * character is lost, are removed. A hook's red "[BLOCKED]" used to reach the feed as squares and "[0;31m".
 */
export function cleanError(error: string): string {
  return error.replace(/\u001b?\[(?:\d{1,3}(?:;\d{1,3})*)m/g, '').replace(/�/g, '').replace(/\s+/g, ' ').trim();
}

/** A failure that comes from a rule of the setup, not from the work, and the instruction that gets past it. */
export interface RuleBlock {
  /** The same blocker reads the same, so it is recognised when it comes back. */
  key: string;
  /** A sentence for the feed. */
  summary: string;
  /** What every agent is told, written as an instruction. */
  note: string;
  /** The word a hook rejected, when it named one. */
  word?: string;
}

/**
 * Whether an error is a rule of the environment (a git hook refusing a commit) rather than a fault in the code. Retrying
 * the same work cannot get past one, so the crew works out the instruction that does and gives it to every agent.
 */
export function ruleBlock(error: string): RuleBlock | null {
  const text = cleanError(error);
  const tagged = /self-tagging detected:\s*'([^']{1,40})'/i.exec(text);
  if (tagged) {
    const word = tagged[1]!.trim();
    return {
      key: `selftag:${word.toLowerCase()}`,
      word,
      summary: `A commit hook rejects the word "${word}" in commit messages, even though it is part of this project's name. Every agent has been told to leave it out.`,
      note: `A commit hook rejects any commit message that contains the word "${word}", in any letter case, even when it is part of this project's name or a task title. Write commit messages that describe what changed without that word (for example "assistant panel" instead). Never bypass or disable the hook.`,
    };
  }
  if (/\[BLOCKED\]|commit blocked|(?:pre-commit|commit-msg|pre-push) hook|hook (?:declined|rejected|blocked|failed)/i.test(text)) {
    return {
      key: `hook:${text.toLowerCase().replace(/[^a-z]+/g, ' ').trim().slice(0, 60)}`,
      summary: 'A git hook blocked a commit. Every agent has been told to change the commit so the hook accepts it.',
      note: `A git hook blocked a commit with this reason: "${text.slice(0, 240)}". Change the commit message, or the change, so the hook accepts it. Never bypass or disable the hook.`,
    };
  }
  return null;
}

/** Adds what the crew has learned to the goal every agent reads, keeping the start of the goal and at most 4,000 characters. */
function withGuidance(run: CrewRun, note: string): CrewRun {
  if (run.goal.includes(note)) return run;
  const heading = '\n\nWhat the crew has learned:\n';
  const base = run.goal.includes(heading) ? run.goal : `${run.goal}${heading}`.slice(0, 4_000);
  const line = `${base.endsWith(heading) ? '' : '\n'}- ${note}`;
  const room = 4_000 - line.length;
  return { ...run, goal: `${base.slice(0, Math.max(0, room))}${line}` };
}

/**
 * A build that failed, with one difference from `failBuild`: when the failure is a rule of the setup the crew has not
 * met before, retrying the same way would only fail again, so the instruction that gets past it goes to every agent
 * first, this task starts again without spending a retry, and any other task that failed the same way starts fresh.
 * The same blocker coming back after that is counted as a failure like any other.
 */
export function failBuildSmart(run: CrewRun, taskId: string, error: string, at: string): CrewRun {
  const block = ruleBlock(error);
  if (!block || run.knownBlockers.includes(block.key)) return failBuild(run, taskId, cleanError(error), at);
  const task = taskOf(run, taskId);
  const word = block.word?.toLowerCase();
  const fingerprint = cleanError(error).toLowerCase().slice(0, 40);
  let next = withGuidance({ ...run, knownBlockers: [...run.knownBlockers, block.key].slice(-20) }, block.note);
  next = {
    ...next,
    updatedAt: at,
    tasks: next.tasks.map((item) => {
      if (item.id === taskId) return { ...item, status: 'backlog' as const, note: '', updatedAt: at };
      const sameCause = item.note.startsWith('Build failed') && (word ? item.note.toLowerCase().includes(word) : item.note.toLowerCase().includes(fingerprint));
      return sameCause ? { ...item, note: '', updatedAt: at } : item;
    }),
  };
  return feed(next, { who: 'crew', kind: 'info', text: `${block.summary} "${task.title}" starts again.`, taskId }, at);
}

/** The project's own check failed after every task was accepted: one more task, for a builder, to make it pass. */
export function addCheckFix(run: CrewRun, output: string, at: string): CrewRun {
  const builder = run.config.roles.find((role) => role.kind === 'builder') ?? run.config.roles.find((role) => roleAccess(role) === 'edit');
  if (!builder) return feed({ ...run, status: 'needsYou', ask: { reason: 'noProgress', message: 'The project check failed and no role can edit files to fix it.' } }, { who: 'crew', kind: 'needsYou', text: 'The project check failed and no role can edit files to fix it.' }, at);
  const attempts = run.tasks.filter((task) => task.id.startsWith('check-fix-')).length + 1;
  if (attempts > run.config.limits.maxSendBacks) {
    const message = `The project check "${run.config.checkCommand}" still fails after ${attempts - 1} fix attempts.`;
    return feed({ ...run, status: 'needsYou', ask: { reason: 'sendBacks', message } }, { who: 'crew', kind: 'needsYou', text: message }, at);
  }
  const { run: next } = addTasks(run, [{
    id: `check-fix-${attempts}`, title: `Make the project check pass (attempt ${attempts})`, role: builder.id,
    description: `The command "${run.config.checkCommand}" failed. Its output:
${output.slice(-3_000)}`,
    acceptance: [`"${run.config.checkCommand}" exits with code 0.`],
  }], at, 'lead');
  return feed(next, { who: 'crew', kind: 'info', text: `The project check failed, so a fix task was added (attempt ${attempts}).` }, at);
}

/**
 * Reads the Lead's verdict out of its reply. The Lead is asked for one JSON object; anything else (prose, a fence,
 * a missing field) reads as "no verdict" and the caller asks again, because guessing would accept unchecked work.
 */
export function parseReview(text: string): { verdict: CrewReview['verdict']; feedback: string; notes: string[] } | null {
  const candidates = jsonObjects(text).filter((candidate) => candidate.includes('"verdict"'));
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as { verdict?: unknown; feedback?: unknown; notes?: unknown };
      const verdict = value.verdict === 'accept' || value.verdict === 'sendBack' || value.verdict === 'needsYou' ? value.verdict : null;
      if (!verdict) continue;
      const feedback = typeof value.feedback === 'string' ? value.feedback : '';
      // Sending work back with no reason gives the builder nothing to fix, so that is not a usable verdict either.
      if (verdict !== 'accept' && feedback.trim().length === 0) continue;
      // Things a reviewer noticed that are not a reason to stop the task; kept for the person, not acted on.
      const notes = Array.isArray(value.notes)
        ? value.notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0).map((note) => note.trim().slice(0, 300)).slice(0, 6)
        : [];
      return { verdict, feedback, notes };
    } catch {
      continue;
    }
  }
  return null;
}
