import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { LeadConversationPanel } from '../../apps/desktop/src/renderer/src/components/RightPane';
import type { ConversationRecord } from '@kai/contracts';

const inventory = {
  apiProviders: [
    { provider: 'lmstudio', credentialId: 'provider.lmstudio', label: 'Local Lab', tier: 'Local' as const, available: true, models: ['local-small', 'local-large'], defaultModel: '', baseUrl: 'http://127.0.0.1:1234/v1' },
    { provider: 'openai', credentialId: 'provider.openai', label: 'Cloud Lab', tier: 'Paid API' as const, available: true, models: ['cloud-fast', 'cloud-strong'], defaultModel: '', baseUrl: 'https://api.example.test/v1' },
  ],
  cliAgents: [{ agent: 'claude' as const, label: 'Claude CLI', tier: 'Subscription' as const, available: true, models: ['sonnet', 'opus'] }],
};

function chat(id: string, text: string): ConversationRecord {
  const now = '2026-11-27T00:00:00.000Z';
  return { schemaVersion: 1, id, projectId: 'selector-test-project', title: 'Lead', createdAt: now, updatedAt: now, archived: false, unread: false, activeAgent: 'codex', route: 'direct', autonomy: 'plan', execution: 'cli', turns: [{ id: `${id}-u`, role: 'user', text, createdAt: now }], events: [] };
}

function Harness(): ReactNode {
  const [chats, setChats] = useState([chat('selector-chat-2', 'Second chat'), chat('selector-chat-1', 'First chat')]);
  const [selectedId, setSelectedId] = useState('selector-chat-2');
  const selected = chats.find((item) => item.id === selectedId) ?? null;
  const createChat = (): void => {
    const next = chat(`selector-chat-${chats.length + 1}`, '');
    setChats((items) => [next, ...items]);
    setSelectedId(next.id);
  };
  return <div style={{ width: '100%', height: '100vh', display: 'flex', justifyContent: 'flex-end' }}>
    <div style={{ width: 'min(600px, 100vw)', height: '100%', border: '1px solid #888' }}>
      <LeadConversationPanel
        projectName="Selector Test"
        projectId="selector-test-project"
        conversation={selected}
        conversations={chats}
        onSelectConversation={setSelectedId}
        onNewConversation={createChat}
        streamingText=""
        running={false}
        error={null}
        approvals={[]}
        inventory={inventory}
        savedCoach={null}
        composerTarget={null}
        onAsk={() => undefined}
        onStop={() => undefined}
        onClearError={() => undefined}
        onRespondApproval={() => undefined}
        onSendToBuilder={() => undefined}
        onReviewIdea={() => undefined}
      />
    </div>
  </div>;
}

function mount(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing Lead test root');
  createRoot(root).render(<Harness />);
}

Object.assign(window, { mountLeadSelectorTest: mount });
mount();
