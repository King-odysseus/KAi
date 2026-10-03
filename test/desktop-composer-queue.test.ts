import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '@kai/contracts';
import { loadComposerQueue, queuedPromptWasAccepted, saveComposerQueue, type QueuedPrompt } from '../apps/desktop/src/renderer/src/components/composer-queue';

const item: QueuedPrompt = {
  id: 'queued-1', conversationId: 'conversation-a', text: 'Check the tests',
  options: { agent: 'codex', execution: 'cli', route: 'direct', autonomy: 'ask' },
  status: 'queued',
};

function storage(): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe('conversation-owned composer queue', () => {
  it('restores each conversation separately and retries a sending item after restart', () => {
    storage();
    saveComposerQueue({
      'conversation-a': [{ ...item, status: 'sending' }],
      'conversation-b': [{ ...item, id: 'queued-2', conversationId: 'conversation-b', text: 'Another task', status: 'blocked' }],
    });
    const recovered = loadComposerQueue();
    expect(recovered['conversation-a']).toMatchObject([{ id: 'queued-1', status: 'queued' }]);
    expect(recovered['conversation-b']).toMatchObject([{ id: 'queued-2', status: 'blocked' }]);
  });

  it('recognizes the committed user turn by ID even when prompts have identical text', () => {
    const conversation = { turns: [
      { id: 'turn-1', role: 'user', text: item.text, clientMessageId: 'queued-1' },
    ] } as ConversationRecord;
    expect(queuedPromptWasAccepted(conversation, 'queued-1')).toBe(true);
    expect(queuedPromptWasAccepted(conversation, 'queued-2')).toBe(false);
  });

  it('persists the saved image path without filling browser storage with its data URL', () => {
    const values = storage();
    saveComposerQueue({ 'conversation-a': [{
      ...item,
      options: { ...item.options, contextChips: [{ type: 'image', name: 'shot.png', path: 'C:/images/shot.png', dataUrl: 'data:image/png;base64,AAAA' }] },
    }] });
    expect(values.get('kai.composer.queuedPrompts')).toContain('C:/images/shot.png');
    expect(values.get('kai.composer.queuedPrompts')).not.toContain('base64');
  });

  it('reports when storage refuses a queued message', () => {
    vi.stubGlobal('window', { localStorage: { setItem: () => { throw new Error('quota exceeded'); } } });
    expect(saveComposerQueue({ 'conversation-a': [item] })).toBe(false);
  });
});
