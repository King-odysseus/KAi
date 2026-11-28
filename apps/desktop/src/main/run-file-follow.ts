import { randomUUID } from 'node:crypto';
import type { AgentRunRequest, PersistedEvent } from '@kai/contracts';
import { onProjectFileChanged, startWatchingProject } from './project-knowledge';
import { readProjectFile } from './project-files';

/** Observe real disk writes, including shell tools and native agents that omit edit events. */
export async function followRunFiles(root: string, request: AgentRunRequest, emit: (event: PersistedEvent) => void) {
  const events: PersistedEvent[] = [];
  const hashes = new Map<string, string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const reads = new Set<Promise<void>>();
  const publish = (file: string) => {
    const read = readProjectFile(root, file).then((opened) => {
      if (hashes.get(file) === opened.hash) return;
      hashes.set(file, opened.hash);
      const event: PersistedEvent = { schemaVersion: 1, id: `evt_${randomUUID()}`, taskId: request.conversationId, timestamp: new Date().toISOString(), agent: request.agent, type: 'file.edit.applied', filePath: file, summary: 'File changed on disk during this run; may include manual edits.' };
      events.push(event); emit(event);
    }).catch(() => { /* The shared reader rejects directories, oversized files and paths outside the project. */ });
    reads.add(read); void read.finally(() => reads.delete(read));
  };
  const unsubscribe = onProjectFileChanged(root, (file) => {
    if (/(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|[^/]*\.(?:pem|key|pfx|p12))$/i.test(file)) return;
    const prior = pending.get(file); if (prior) clearTimeout(prior);
    pending.set(file, setTimeout(() => { pending.delete(file); publish(file); }, 150));
  });
  await startWatchingProject(root).catch(() => undefined);
  let stopped: Promise<PersistedEvent[]> | null = null;
  return { stop: () => stopped ??= (async () => {
    unsubscribe();
    for (const [file, timer] of pending) { clearTimeout(timer); publish(file); }
    pending.clear();
    await Promise.all([...reads]);
    return events;
  })() };
}
