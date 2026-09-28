import type { IpcChannel } from '@kai/contracts';

/** How exposed a channel is. `write` entries are the ones that change the machine, not just read it. */
export type RemoteScope = 'read' | 'write';

/**
 * Default deny: a channel that is absent here cannot be reached over the gateway, whatever the caller
 * holds. The bearer token is the only thing in front of these handlers and they spawn CLIs and write
 * files, so adding a line is a security decision rather than a convenience one: every `write` entry
 * below states what an attacker holding the token gets from it, and each one is here for a screen the
 * phone actually has. A channel with no caller is not a convenience worth the surface.
 */
export const REMOTE_ALLOWLIST: Readonly<Partial<Record<IpcChannel, RemoteScope>>> = {
  // Reads: enough to see what is running and what it costs, with nothing that changes the machine.
  'app:get-bootstrap': 'read',
  'services:status': 'read',
  'conversations:list': 'read',
  'conversations:get': 'read',
  'workflows:list-runs': 'read',
  'team:record': 'read',
  'usage:summary': 'read',
  'context:git-diff': 'read',
  'studio:board-read': 'read',
  'studio:artifacts-read': 'read',
  'studio:artifacts-files': 'read',
  // The task board the phone shows. Narrower than it looks: the handler fixes the brain operation and
  // lets only a project filter through, so what a stolen token gets is the titles, notes and holders of
  // the user's own tasks. The generic door that could also complete or prune them is not here.
  'remote:tasks': 'read',

  // Answering an approval is the point of the phone, and the one write the whole design is tested by.
  // What a stolen token gets: the ability to approve a command the desktop is already waiting on — so
  // the phone must put the command, the risk and the project in front of the user before it sends. The
  // handler narrows it further: the id has to have been raised, and the request has to come from the
  // window that raised it, which is why the phone sends the window the event carried.
  'agents:approval-response': 'write',
  // Sending a turn runs a real agent on this machine with the user's own credentials. That is the same
  // power the desktop has and the reason the phone exists; the prompt is bounded by the schema and goes
  // into a conversation that already exists rather than starting one.
  'agents:run': 'write',
  // Ending or holding work already in flight. Abused, it wastes a run; it grants no access to a file, a
  // shell or a credential that reaching the run did not already grant.
  'agents:cancel': 'write',
  'agents:pause': 'write',
  'agents:resume': 'write',
  'workflows:stop': 'write',
  'workflows:resume': 'write',
  // The board is KAI's own bookkeeping about its own work, not the project: a move changes a card's
  // column and a claim changes who holds it. Both write under KAI's studio directory, never the repo,
  // and a move to `done` is still refused by the board itself until a check has passed.
  'studio:board-move': 'write',
  'studio:board-claim': 'write',
};

/** The scope `channel` is reachable at, or null when it is not reachable remotely at all. */
export function remoteScopeFor(channel: IpcChannel): RemoteScope | null {
  return REMOTE_ALLOWLIST[channel] ?? null;
}
