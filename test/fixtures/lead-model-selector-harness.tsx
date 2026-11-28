import { inventory } from './lead-model-inventory';
import { LeadTaskCard } from '../../apps/desktop/src/renderer/src/components/LeadTaskCard';
import { LeadHandoffHarness } from './lead-handoff-harness';
import { ThemeProvider } from 'flowbite-react';
import { kaiFlowbiteTheme } from '../../apps/desktop/src/renderer/src/flowbite-theme';
import { CodeLearningTabs, restoredCodeLearningTab, type CodeLearningTab } from '../../apps/desktop/src/renderer/src/components/CodeLearningTabs';
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { LeadConversationPanel } from '../../apps/desktop/src/renderer/src/components/RightPane';
import type { ConversationRecord } from '@kai/contracts';



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

function LearningHarness(): ReactNode {
 const [tab, setTab] = useState<CodeLearningTab>(() => restoredCodeLearningTab(localStorage.getItem('kai.codeSidePanel')));
 return <div><CodeLearningTabs value={tab} onChange={(next) => { setTab(next); localStorage.setItem('kai.codeSidePanel', next); }} /><section aria-label="Selected learning panel">{tab}</section></div>;
}

function TaskHarness(): ReactNode {
 const [enabled, setEnabled] = useState(true);
 const [draft, setDraft] = useState('');
 const [question, setQuestion] = useState('');
 return <div style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}><button onClick={() => setEnabled(!enabled)}>Toggle Builder</button><LeadTaskCard task={'### Goal\nAdd a form.\n### Files\n- src/form.ts\n### Done checks\n- Validates inputs.'} builderEnabled={enabled} onSend={setDraft} onChange={setQuestion} /><textarea aria-label="Builder draft" value={draft} readOnly /><textarea aria-label="Lead revision" value={question} readOnly /></div>;
}

function mount(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing Lead test root');
  createRoot(root).render(<ThemeProvider theme={kaiFlowbiteTheme}>{location.search === '?handoff' ? <LeadHandoffHarness /> : location.search === '?task' ? <TaskHarness /> : location.search === '?learning' ? <LearningHarness /> : <Harness />}</ThemeProvider>);
}

Object.assign(window, { mountLeadSelectorTest: mount });
mount();
