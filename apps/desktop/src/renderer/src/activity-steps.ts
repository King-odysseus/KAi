import type { PersistedEvent } from '@kai/contracts';

/**
 * What the live activity card shows: one row per thing the agent did, in the order it did them.
 *
 * Kept as a plain function of the run's events so the rows and their wording can be tested without a DOM. The card
 * and the composer's status line both read this, so the one step that is happening now is named once, in one voice.
 */
export type ActivityStepKind = 'read' | 'edit' | 'command' | 'agent' | 'other';
export type ActivityStepState = 'active' | 'done' | 'failed';

export interface ActivityStep {
  id: string;
  kind: ActivityStepKind;
  state: ActivityStepState;
  /** The file, or the raw command. A command is shown behind an arrow, never as the row's headline. */
  target: string;
  added?: number;
  removed?: number;
  /** The unified diff of an edit, once the agent has said what it changed. */
  diff?: string;
}

const READ_TOOL = /(read|search|grep|glob|list|find|open|cat|view)/;
const EDIT_TOOL = /(apply_patch|edit|write|create|delete|rename|replace)/;
const COMMAND_TOOL = /(shell|command|exec|terminal|bash|powershell|test|lint|check|build|typecheck|verify|compile)/;
const AGENT_TOOL = new Set(['task', 'explore']);

const PATH_KEYS = ['path', 'filePath', 'file_path', 'file', 'target_file'] as const;

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function pathOf(input: unknown): string {
  const record = inputRecord(input);
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function commandOf(input: unknown): string {
  const record = inputRecord(input);
  const value = record.command ?? record.cmd ?? record.script;
  return typeof value === 'string' ? value : '';
}

function stateOf(status: string | undefined): ActivityStepState {
  if (status === 'failed') return 'failed';
  return status === 'completed' ? 'done' : 'active';
}

/** The last path segment, whichever way the path is written. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function deriveActivitySteps(events: readonly PersistedEvent[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const byCall = new Map<string, ActivityStep>();
  const edits = new Map<string, ActivityStep>();

  const editFor = (path: string, id: string): ActivityStep => {
    const existing = edits.get(path);
    if (existing) return existing;
    const created: ActivityStep = { id, kind: 'edit', state: 'done', target: path };
    edits.set(path, created);
    steps.push(created);
    return created;
  };

  for (const event of events) {
    if (event.type === 'tool.call') {
      const name = event.name.toLowerCase();
      const state = stateOf(event.status);
      const known = event.callId ? byCall.get(event.callId) : undefined;
      if (known) {
        known.state = state;
        continue;
      }
      let step: ActivityStep | null = null;
      if (AGENT_TOOL.has(name)) step = { id: event.id, kind: 'agent', state, target: event.name };
      else if (EDIT_TOOL.test(name)) {
        const path = pathOf(event.input);
        if (path) {
          // A second call on the same file is the same row, read again.
          const edit = editFor(path, event.id);
          edit.state = state;
          if (event.callId) byCall.set(event.callId, edit);
          continue;
        }
        step = { id: event.id, kind: 'edit', state, target: '' };
      } else if (COMMAND_TOOL.test(name) && !READ_TOOL.test(name)) step = { id: event.id, kind: 'command', state, target: commandOf(event.input) || event.name };
      else if (READ_TOOL.test(name)) {
        const path = pathOf(event.input);
        step = { id: event.id, kind: 'read', state, target: path || (inputRecord(event.input).pattern as string | undefined) || (inputRecord(event.input).query as string | undefined) || event.name };
      } else step = { id: event.id, kind: 'other', state, target: event.name };
      if (step.kind === 'edit' && step.target === '') step.target = event.name;
      steps.push(step);
      if (event.callId) byCall.set(event.callId, step);
    } else if (event.type === 'file.change') {
      const edit = editFor(event.path, event.id);
      edit.state = 'done';
      edit.added = event.added;
      edit.removed = event.removed;
    } else if (event.type === 'file.edit.applied') {
      editFor(event.filePath, event.id).state = 'done';
    } else if (event.type === 'diff.proposal') {
      const edit = editFor(event.filePath, event.id);
      if (event.diff) edit.diff = event.diff;
    } else if (event.type === 'turn.changes') {
      for (const file of event.files) {
        const edit = editFor(file.path, `${event.id}:${file.path}`);
        edit.state = 'done';
        edit.added = file.added;
        edit.removed = file.removed;
      }
    }
  }
  return steps;
}

/** The sentence a row says: what it is doing while it does it, what it did once it has. */
export function stepSentence(step: ActivityStep): { verb: string; target: string } {
  const active = step.state === 'active';
  const name = step.kind === 'command' ? 'command' : fileName(step.target);
  if (step.kind === 'read') return { verb: active ? 'Reading' : 'Read', target: name };
  if (step.kind === 'edit') return { verb: step.state === 'failed' ? 'Could not update' : active ? 'Editing' : 'Updated', target: name };
  if (step.kind === 'command') return { verb: step.state === 'failed' ? 'Command failed' : active ? 'Running' : 'Ran', target: 'a command' };
  if (step.kind === 'agent') return { verb: active ? 'Exploring' : 'Explored', target: 'the project' };
  return { verb: active ? 'Using' : 'Used', target: step.target };
}

/** The one step that is happening now, for the composer's status line; null when nothing is mid-way. */
export function currentStep(steps: readonly ActivityStep[]): string | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (step.state !== 'active') continue;
    const { verb, target } = stepSentence(step);
    return `${verb} ${target}`;
  }
  return null;
}

export interface DiffLine { kind: 'add' | 'remove' | 'context' | 'hunk' | 'file'; text: string }

/** A unified diff as lines to colour. Header lines are kept apart so they can be drawn quietly. */
export function parseDiff(diff: string): DiffLine[] {
  return diff.split('\n').map((line): DiffLine => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return { kind: 'file', text: line };
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'remove', text: line };
    return { kind: 'context', text: line };
  });
}
