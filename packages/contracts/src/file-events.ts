import type { PersistedEvent } from './events';

const WRITES = new Set(['write_file', 'create_file', 'replace_in_file', 'multi_edit', 'delete_file', 'move_file', 'Edit', 'Write', 'apply_patch']);

/** File paths from real edit activity, including native CLI events. Proposals and reads are not edits. */
export function writtenPaths(event: PersistedEvent, includePending = false): string[] {
  if (event.type === 'file.change') return [event.path];
  if (event.type === 'file.edit.applied') return [event.filePath];
  if (event.type !== 'tool.call' || (event.status !== 'completed' && !(includePending && event.status === 'started')) || !WRITES.has(event.name.split('.').at(-1)!)) return [];
  const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
  const file = input.path ?? input.file_path ?? input.filePath;
  const patch = typeof event.input === 'string' ? event.input : input.patch ?? input.patchText ?? input.input;
  return [...new Set([
    ...(typeof file === 'string' ? [file] : []),
    ...(typeof patch === 'string' ? [...patch.matchAll(/^\*{3} (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim()) : []),
  ])];
}
