import { describe, expect, it } from 'vitest';
import { isCrewConversation } from '../apps/desktop/src/renderer/src/crew-conversation';

describe('telling a crew work log from a chat', () => {
  it('recognises a conversation marked as the crew\'s', () => {
    expect(isCrewConversation({ title: 'anything', origin: { kind: 'crew', runId: 'crew_1' } })).toBe(true);
  });

  it('recognises one made before the marker existed by the title the crew gave it', () => {
    expect(isCrewConversation({ title: 'Crew: "C:\\Users\\x\\plan.md" implement this plan' })).toBe(true);
    expect(isCrewConversation({ title: 'Crew task: Build the shell' })).toBe(true);
  });

  it('leaves the person\'s own chats and Autopilot cards alone', () => {
    expect(isCrewConversation({ title: 'Fix the login bug' })).toBe(false);
    expect(isCrewConversation({ title: 'Crew: but marked as a card', origin: { kind: 'autopilot', studioProjectId: 's', cardId: 'c', cardTitle: 't' } })).toBe(false);
    expect(isCrewConversation({ title: 'Crewmates plan' })).toBe(false);
  });
});
