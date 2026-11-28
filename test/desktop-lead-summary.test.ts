import { expect, it, vi } from 'vitest';
import { ipcInputSchemas, type ConversationRecord } from '@kai/contracts';
import { hydrateLeadConversation } from '../apps/desktop/src/renderer/src/components/lead-delivery';

const full: ConversationRecord = { schemaVersion: 1, id: 'lead-a', projectId: 'project-a', title: 'Existing discussion', createdAt: '2026-11-27T10:00:00.000Z', updatedAt: '2026-11-27T10:02:00.000Z', archived: false, unread: false, activeAgent: null, route: null, autonomy: null, origin: { kind: 'lead', projectId: 'project-a' }, turns: [{ id: 'u', role: 'user', text: 'Existing full question', createdAt: '2026-11-27T10:00:00.000Z' }, { id: 'a', role: 'assistant', text: 'Existing answer', createdAt: '2026-11-27T10:01:00.000Z' }], events: [] };

it('loads a list summary before saving Lead context and keeps the complete history', async () => {
 const summary = { ...full, __summary: true, turns: [], events: [] };
 const load = vi.fn(async () => full);
 const hydrated = await hydrateLeadConversation(summary, load);
 const request = { ...hydrated, leadContext: { included: ['brief.md'], omitted: [], unavailable: [], suppliedAt: full.updatedAt } };
 expect(ipcInputSchemas['conversations:save'].safeParse(request).success).toBe(true);
 expect(load).toHaveBeenCalledWith(full.id);
 expect(request.turns).toEqual(full.turns);
});

it('does not save an empty history when loading the summary fails', async () => {
 await expect(hydrateLeadConversation({ ...full, __summary: true, turns: [], events: [] }, async () => null)).rejects.toThrow('complete Lead conversation');
});
it('keeps an already loaded conversation intact', async () => {
 const load = vi.fn();
 expect(await hydrateLeadConversation(full, load)).toBe(full);
 expect(load).not.toHaveBeenCalled();
});
