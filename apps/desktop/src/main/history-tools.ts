import type { ExternalToolPort, ProjectToolExecution, ProjectToolPolicy } from './project-tools';

/**
 * Earlier turns of a conversation, read when a model asks instead of sent with every request. A local model pays for
 * every token it is sent in time as well as context, so a run carries the recent turns and looks the rest up here. The
 * turns are the ones on disk, so a turn already folded into a summary can still be read in full.
 */
export interface HistoryAccess {
  turns(conversationId: string): Promise<ReadonlyArray<{ role: string; text: string; toolDigest?: string | undefined }>>;
}

export const READ_HISTORY_TOOL = 'read_history';
const MAX_TURN_CHARACTERS = 6_000;
const INDEX_ENTRIES = 40;
const MATCHES = 5;

export function historyNote(omitted: number): string {
  return `[${omitted} earlier ${omitted === 1 ? 'turn is' : 'turns are'} not shown, to keep this request small. Call ${READ_HISTORY_TOOL} to list them, to read one by number, or to search them.]`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

export function withHistoryTools(port: ExternalToolPort | undefined, conversationId: string, access: HistoryAccess): ExternalToolPort {
  const definition = {
    type: 'function',
    name: READ_HISTORY_TOOL,
    description: 'Read earlier turns of this conversation that are not in the request. With no arguments it lists them; with `turn` it returns one in full; with `query` it returns the turns that mention those words.',
    parameters: {
      type: 'object',
      properties: {
        turn: { type: 'integer', description: 'The number of a turn to read in full (1 is the first).' },
        query: { type: 'string', description: 'Words to look for in earlier turns.' },
      },
      additionalProperties: false,
    },
  };
  return {
    definitions: async () => [...(port ? await port.definitions().catch(() => []) : []), definition],
    policy: (name, autonomy): ProjectToolPolicy | undefined => name === READ_HISTORY_TOOL ? { decision: 'allow' } : port?.policy(name, autonomy),
    execute: async (name, input, signal): Promise<ProjectToolExecution | undefined> => {
      if (name !== READ_HISTORY_TOOL) return port?.execute(name, input, signal);
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      const turns = await access.turns(conversationId).catch(() => []);
      if (turns.length === 0) return { ok: true, output: 'This conversation has no earlier turns.' };
      const label = (index: number): string => `${index + 1}. ${turns[index]!.role === 'user' ? 'You were asked' : 'You answered'}`;

      if (typeof args.turn === 'number' && Number.isInteger(args.turn)) {
        const turn = turns[args.turn - 1];
        if (!turn) return { ok: false, output: { error: `There is no turn ${args.turn}; this conversation has ${turns.length}.` } };
        const body = turn.toolDigest ? `${turn.text}\n\n[What this turn did]\n${turn.toolDigest}` : turn.text;
        return { ok: true, output: `${label(args.turn - 1)}:\n${body.slice(0, MAX_TURN_CHARACTERS)}${body.length > MAX_TURN_CHARACTERS ? '\n[cut]' : ''}` };
      }

      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      if (query) {
        const words = query.split(/\s+/).filter((word) => word.length > 2);
        const needles = words.length ? words : [query];
        const scored = turns
          .map((turn, index) => {
            const lower = `${turn.text}\n${turn.toolDigest ?? ''}`.toLowerCase();
            return { index, hits: needles.filter((word) => lower.includes(word)).length, lower };
          })
          .filter((entry) => entry.hits > 0)
          .sort((a, b) => b.hits - a.hits || b.index - a.index)
          .slice(0, MATCHES);
        if (scored.length === 0) return { ok: true, output: `No earlier turn mentions "${query}".` };
        return {
          ok: true,
          output: scored.map((entry) => {
            const at = Math.max(0, entry.lower.indexOf(needles.find((word) => entry.lower.includes(word)) ?? ''));
            const source = `${turns[entry.index]!.text}\n${turns[entry.index]!.toolDigest ?? ''}`;
            return `${label(entry.index)}: …${oneLine(source.slice(Math.max(0, at - 150), at + 350), 500)}…`;
          }).join('\n\n'),
        };
      }

      const start = Math.max(0, turns.length - INDEX_ENTRIES);
      const lines = turns.slice(start).map((turn, offset) => `${label(start + offset)}: ${oneLine(turn.text, 110)}`);
      return { ok: true, output: `${start > 0 ? `(the ${turns.length - start} most recent of ${turns.length} turns)\n` : ''}${lines.join('\n')}` };
    },
  };
}

/**
 * The turns a local model is sent: the newest that fit `budget` tokens (at least the last two before the request), with
 * a note on the first saying how many were left out and how to read them. A budget of 0 sends everything, as before.
 */
export function windowedHistory<T extends { role: string; text: string }>(turns: readonly T[], budget: number): T[] {
  if (budget <= 0 || turns.length <= 3) return [...turns];
  const current = turns[turns.length - 1]!;
  const earlier = turns.slice(0, -1);
  let used = 0;
  let keepFrom = earlier.length;
  while (keepFrom > 0) {
    const cost = Math.ceil(earlier[keepFrom - 1]!.text.length / 4);
    if (earlier.length - keepFrom >= 2 && used + cost > budget) break;
    used += cost;
    keepFrom -= 1;
  }
  if (keepFrom === 0) return [...turns];
  const kept = earlier.slice(keepFrom);
  const first = kept[0]!;
  return [{ ...first, text: `${historyNote(keepFrom)}\n\n${first.text}` }, ...kept.slice(1), current];
}
