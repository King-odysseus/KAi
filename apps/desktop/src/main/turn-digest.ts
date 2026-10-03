import type { PersistedEvent } from '@kai/contracts';

/**
 * What a turn actually did, as a short note carried into the next turn's history.
 *
 * The Direct API path has no live session: a follow-up message only ever saw the previous turn's closing prose
 * (`DirectApiHistoryTurn` was `{ role, text }`), so a model picking up a conversation had no idea which files it had
 * already read or changed, or what a command it ran had printed. It would re-read files it had just read, or repeat
 * a command whose result it already had. This builds a short account from the turn's own events — the facts, not
 * the model's summary of them — so the next turn starts with the record a person would have if they had just
 * watched the first one happen.
 *
 * Kept short on purpose: this rides along on every later turn of the conversation, so it is a list of what happened,
 * not a transcript of it. Tool arguments and outputs are not included; only the path, command, and outcome are.
 */

const MAX_ENTRIES = 20;
const MAX_COMMAND_LENGTH = 200;

interface ToolCallLike {
  type: 'tool.call';
  name: string;
  status: 'started' | 'updated' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
}

function isToolCall(event: PersistedEvent): event is Extract<PersistedEvent, { type: 'tool.call' }> {
  return event.type === 'tool.call';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === 'string' ? field : undefined;
}

/** One line for a finished tool call, or undefined for a call this digest has nothing useful to say about. */
function lineFor(event: ToolCallLike): string | undefined {
  if (event.status !== 'completed' && event.status !== 'failed') return undefined;
  const failed = event.status === 'failed';
  const input = event.input;
  switch (event.name) {
    case 'read_file': {
      const path = stringField(input, 'path');
      return path ? `${failed ? 'Tried to read' : 'Read'} ${path}` : undefined;
    }
    case 'search_files': {
      const query = stringField(input, 'query');
      return query ? `Searched for "${query}"` : undefined;
    }
    case 'list_files':
      return 'Listed project files';
    case 'write_file':
    case 'create_file':
      return path(input, failed, 'create');
    case 'replace_in_file':
    case 'multi_edit':
      return path(input, failed, 'edit');
    case 'move_file': {
      const from = stringField(input, 'from');
      const to = stringField(input, 'to');
      return from && to ? `${failed ? 'Failed to move' : 'Moved'} ${from} to ${to}` : undefined;
    }
    case 'delete_file':
      return path(input, failed, 'delete');
    case 'run_command': {
      const command = stringField(input, 'command');
      if (!command) return undefined;
      const clipped = command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH)}...` : command;
      const output = asRecord(event.output);
      const exitCode = output && typeof output.exitCode === 'number' ? output.exitCode : undefined;
      const outcome = failed ? 'failed' : exitCode === 0 ? 'succeeded' : exitCode !== undefined ? `exited ${exitCode}` : 'ran';
      return `Ran \`${clipped}\` (${outcome})`;
    }
    case 'explore': {
      const question = stringField(input, 'question');
      return question ? `Explored: ${question}` : undefined;
    }
    default:
      return undefined;
  }
}

function path(input: unknown, failed: boolean, verb: 'create' | 'edit' | 'delete'): string | undefined {
  const target = stringField(input, 'path');
  if (!target) return undefined;
  const done = { create: 'Created', edit: 'Edited', delete: 'Deleted' }[verb];
  const tried = { create: 'Failed to create', edit: 'Failed to edit', delete: 'Failed to delete' }[verb];
  return `${failed ? tried : done} ${target}`;
}

/**
 * Builds the digest for one turn's events. Returns an empty string when the turn made no tool calls worth noting
 * (a plain conversational reply), so callers can skip attaching anything.
 */
export function buildTurnDigest(events: readonly PersistedEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (!isToolCall(event)) continue;
    const line = lineFor(event);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return '';
  const kept = lines.length > MAX_ENTRIES
    ? [...lines.slice(0, MAX_ENTRIES - 1), `...and ${lines.length - (MAX_ENTRIES - 1)} more actions`]
    : lines;
  return kept.map((line) => `- ${line}`).join('\n');
}
