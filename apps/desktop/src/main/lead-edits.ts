import { createHash } from 'node:crypto';
import { parseLeadEditSuggestion, studioBoardSchema, type ConversationRecord, type LeadEditProposal, type VerificationRun } from '@kai/contracts';
import { readProjectFile, writeProjectFile } from './project-files';
import { doneBlockedBy } from './board';
import { currentFileHashes, hashFile } from './verification';

export interface LeadEditStore {
  get(id: string): Promise<ConversationRecord | null>;
  save(record: ConversationRecord): Promise<unknown>;
  list(): Promise<ConversationRecord[]>;
  root(projectId: string): Promise<string>;
  runs?(projectId: string): Promise<VerificationRun[]>;
}
const locks = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(work);
  locks.set(key, task);
  try { return await task; } finally { if (locks.get(key) === task) locks.delete(key); }
}
const normal = (value: string) => value.trim().toLowerCase().replace(/[.!:]$/, '').replace(/\s+/g, ' ');
function allowedPath(input: string): string {
  const file = input.replaceAll('\\', '/');
  if (!file || file.startsWith('/') || file.includes(':') || file.split('/').some((part) => !part || part === '.' || part === '..')
    || /(?:^|\/)(?:\.git|node_modules|vendor|dist|out|release|\.env[^/]*|.*secret.*|.*credential.*)(?:\/|$)/i.test(file)
    || !/\.(?:md|txt|json|ts|tsx|js|jsx|mjs|cjs|css|scss|html|vue|svelte|py|go|rs|java|cs|rb|php|yaml|yml|toml)$/i.test(file)) throw new Error('This file must be handled in Builder; Lead edits are limited to small project text corrections.');
  if (file.toLowerCase() === '.kai/spec/status.md') throw new Error('status.md is generated from recorded facts, not model edits.');
  return /^\.kai\/spec\/(?:board\.json|plan\.md)$/i.test(file) ? file.toLowerCase() : file;
}
async function leadRecord(store: LeadEditStore, id: string, requireWrite = true) {
  const lead = await store.get(id);
  if (!lead?.projectId || lead.origin?.kind !== 'lead' || lead.origin.projectId !== lead.projectId) throw new Error('Open the owning project Lead chat to edit.');
  if (requireWrite && (!lead.leadAccess || lead.leadAccess === 'read-only')) throw new Error('Lead access is Read-only. Choose Ask before edits or Plan edits allowed.');
  return lead;
}
async function opened(root: string, file: string) {
  try { return await readProjectFile(root, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function authoritative(root: string, file: string): Promise<void> {
  if (file.toLowerCase() === '.kai/spec/plan.md' && await opened(root, '.kai/spec/board.json')) throw new Error('The Studio board is authoritative. Update its existing cards instead of creating a second plan.');
}
function replacement(content: string | null, before: string, after: string): string {
  if (before === after) throw new Error('The proposal contains no change.');
  if (before.split('\n').length + after.split('\n').length > 200) throw new Error('This change is too large for Lead. Send a small task to Builder.');
  if (content === null) {
    if (before) throw new Error('The proposed original text does not exist. Read the current file and prepare the edit again.');
    return after;
  }
  if (!before || content.indexOf(before) < 0 || content.indexOf(before) !== content.lastIndexOf(before)) throw new Error('The original text must match exactly once. Read the current file and prepare the edit again.');
  return content.replace(before, () => after);
}
function validatedBoard(file: string, original: string, content: string): string {
  if (file.toLowerCase() !== '.kai/spec/board.json') return content;
  const previous = studioBoardSchema.parse(JSON.parse(original));
  const next = studioBoardSchema.parse(JSON.parse(content));
  if (previous.requireAcceptance !== next.requireAcceptance) throw new Error('Lead cannot change the Studio acceptance gate.');
  if (previous.cards.some((card) => !next.cards.some((item) => item.id === card.id))) throw new Error('Lead cannot remove existing Studio cards.');
  for (const card of next.cards) {
    const old = previous.cards.find((item) => item.id === card.id);
    if (!old || JSON.stringify([old.reviewDecision, old.check, old.runs]) !== JSON.stringify([card.reviewDecision, card.check, card.runs])) throw new Error('Lead cannot invent Studio acceptance or check evidence. Use Studio review.');
    if (card.status === 'done' && old.status !== 'done' && (old.reviewDecision !== 'accepted' || !old.check || old.stale)) throw new Error('The Studio card still needs its existing review and check gates before Done.');
  }
  return JSON.stringify({ ...next, revision: previous.revision + 1 }, null, 2) + '\n';
}
async function validateBoardEvidence(store: LeadEditStore, projectId: string, root: string, original: string, replacement: string) {
  const previous = studioBoardSchema.parse(JSON.parse(original)), next = studioBoardSchema.parse(JSON.parse(replacement));
  for (const card of next.cards.filter((item) => item.status === 'done' && previous.cards.find((old) => old.id === item.id)?.status !== 'done')) {
    const run = (await store.runs?.(projectId))?.find((item) => item.id === card.check?.runId) ?? null;
    const dirty = await currentFileHashes(root);
    const recordedNow = run ? await Promise.all(run.files.map(async (file) => ({ path: file.path, hash: await hashFile(root, file.path) }))) : null;
    const drifted = dirty === null || dirty.some((file) => !file.path.startsWith('.kai/') && !run?.files.some((item) => item.path === file.path));
    const blocked = doneBlockedBy(card, { run, recordedNow, drifted });
    if (blocked) throw new Error(blocked);
  }
}

/** Automatic maintenance only checks existing steps backed by still-current Passed task evidence. */
async function canMaintainPlan(store: LeadEditStore, lead: ConversationRecord, proposal: LeadEditProposal, root: string): Promise<boolean> {
  if (lead.leadAccess !== 'plan' || !proposal.expectedHash) return false;
  const changedGoals: string[] = [];
  if (proposal.path === '.kai/spec/plan.md') {
    const oldLines = proposal.original.split('\n'), newLines = proposal.replacement.split('\n');
    if (oldLines.length !== newLines.length) return false;
    for (let i = 0; i < oldLines.length; i++) {
      if (oldLines[i] === newLines[i]) continue;
      const old = /^\s*[-*] \[ \] (.+?)\s*$/.exec(oldLines[i]!);
      const next = /^\s*[-*] \[[xX]\] (.+?)\s*$/.exec(newLines[i]!);
      if (!old || !next || old[1] !== next[1]) return false;
      changedGoals.push(normal(old[1]!));
    }
  } else if (proposal.path === '.kai/spec/board.json') {
    const old = studioBoardSchema.parse(JSON.parse(proposal.original)), next = studioBoardSchema.parse(JSON.parse(proposal.replacement));
    const withoutState = (value: typeof old) => JSON.stringify({ ...value, revision: 0, updatedAt: '', cards: value.cards.map((card) => ({ ...card, status: 'backlog', updatedAt: '' })) });
    if (withoutState(old) !== withoutState(next)) return false;
    for (const card of old.cards) {
      const changed = next.cards.find((item) => item.id === card.id)!;
      if (changed.status === card.status) continue;
      if (card.status === 'done' || changed.status !== 'done') return false;
      changedGoals.push(normal(card.title));
    }
  } else return false;
  if (!changedGoals.length) return false;
  const records = await store.list();
  const passed = records.filter((record) => record.projectId === lead.projectId).flatMap((record) => record.leadHandoffs ?? []).filter((item) => item.leadConversationId === lead.id && item.completion?.state === 'passed' && item.completion.files.length);
  for (const goal of changedGoals) {
    const task = passed.find((item) => normal(/^#{1,4} Goal\s*\n([^\n]+)/im.exec(item.task)?.[1] ?? '') === goal);
    if (!task) return false;
    for (const file of task.completion!.files) if ((await opened(root, file.path))?.hash !== file.hash) return false;
  }
  return true;
}

export async function prepareLeadEdit(store: LeadEditStore, conversationId: string, turnId: string): Promise<ConversationRecord> {
  return serial(conversationId, async () => {
    const lead = await leadRecord(store, conversationId);
    if (lead.leadEditProposals?.some((proposal) => proposal.turnId === turnId)) return lead;
    const turn = lead.turns.find((item) => item.id === turnId && item.role === 'assistant');
    if (!turn || lead.leadReviewTurnIds?.includes(turnId)) throw new Error('Only a saved Lead reply can propose an edit.');
    const suggestion = parseLeadEditSuggestion(turn.text);
    if (!suggestion) return lead;
    const file = allowedPath(suggestion.path), root = await store.root(lead.projectId!);
    await authoritative(root, file);
    const current = await opened(root, file);
    if (!current) throw new Error('Lead corrects existing files. Ask Builder to create a new file.');
    if (current && current.size > 100_000) throw new Error('This file is too large for a small Lead correction. Use Builder.');
    const content = validatedBoard(file, current?.content ?? '', replacement(current?.content ?? null, suggestion.before, suggestion.after));
    if (file === '.kai/spec/board.json') await validateBoardEvidence(store, lead.projectId!, root, current.content, content);
    const proposal: LeadEditProposal = { ...suggestion, path: file, id: createHash('sha256').update(`${conversationId}:${turnId}`).digest('hex'), turnId,
      original: current?.content ?? '', replacement: content, expectedHash: current?.hash ?? null, eol: current?.eol ?? 'lf', bom: current?.bom ?? false, state: 'pending', automatic: false };
    const latest = await leadRecord(store, conversationId);
    if (latest.leadAccess !== lead.leadAccess || latest.turns.find((item) => item.id === turnId)?.text !== turn.text) throw new Error('The Lead access or reply changed. Prepare the edit again.');
    const record = { ...latest, leadEditProposals: [...(latest.leadEditProposals ?? []), proposal] };
    await store.save(record);
    return record;
  });
}

export async function decideLeadEdit(store: LeadEditStore, conversationId: string, proposalId: string, action: 'approve' | 'reject' | 'automatic' | 'refresh'): Promise<ConversationRecord> {
  return serial(conversationId, async () => {
    const lead = await leadRecord(store, conversationId, action !== 'reject');
    const proposal = lead.leadEditProposals?.find((item) => item.id === proposalId);
    if (!proposal) throw new Error('The saved edit proposal is unavailable.');
    if (proposal.state === 'applied' || proposal.state === 'rejected') return lead;
    const update = async (patch: Partial<LeadEditProposal>) => {
      const latest = await store.get(conversationId);
      if (!latest || latest.projectId !== lead.projectId) throw new Error('The Lead chat changed.');
      const record = { ...latest, leadEditProposals: latest.leadEditProposals!.map((item) => item.id === proposalId ? { ...item, ...patch } : item) };
      await store.save(record); return record;
    };
    if (action === 'reject') return update({ state: 'rejected', note: 'Edit declined. No file was written.' });
    const root = await store.root(lead.projectId!), file = allowedPath(proposal.path);
    await authoritative(root, file);
    const current = await opened(root, file);
    if ((current?.hash ?? null) !== proposal.expectedHash) {
      if (action !== 'refresh') return update({ state: 'conflict', conflictContent: current && current.size <= 100_000 ? current.content : undefined, note: 'The file changed. Review the current difference and prepare a fresh preview; no edits were overwritten.' });
      if (current && current.size > 100_000) throw new Error('The changed file is too large for Lead. Use Builder.');
      const content = validatedBoard(file, current?.content ?? '', replacement(current?.content ?? null, proposal.before, proposal.after));
      return update({ state: 'pending', conflictContent: undefined, original: current?.content ?? '', replacement: content, expectedHash: current?.hash ?? null, eol: current?.eol ?? 'lf', bom: current?.bom ?? false, automatic: false, note: 'Preview refreshed against your edits. Explicit approval is required again.' });
    }
    if (action === 'refresh') return lead;
    if (action === 'automatic' && (proposal.state !== 'pending' || proposal.note || !await canMaintainPlan(store, lead, proposal, root))) return lead;
    const latest = await leadRecord(store, conversationId);
    if (latest.leadAccess !== lead.leadAccess || JSON.stringify(latest.leadEditProposals?.find((item) => item.id === proposalId)) !== JSON.stringify(proposal)) throw new Error('Lead access or the proposal changed. Review it again.');
    await store.root(lead.projectId!);
    if (file === '.kai/spec/board.json') await validateBoardEvidence(store, lead.projectId!, root, proposal.original, proposal.replacement);
    // No command or mutation tools are granted to the model. Only this exact saved preview is applied by KAI.
    await writeProjectFile(root, file, proposal.replacement, { expectedHash: proposal.expectedHash, eol: proposal.eol, bom: proposal.bom });
    return update({ state: 'applied', automatic: action === 'automatic', note: action === 'automatic' ? 'Plan step marked complete from a matching Passed task and unchanged file evidence.' : 'Exact preview applied with your approval. No check command was run; this edit is not verified.' });
  });
}
