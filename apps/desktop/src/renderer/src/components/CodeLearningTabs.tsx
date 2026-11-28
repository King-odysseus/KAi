import type { ReactNode } from 'react';
import { UiButton } from './UiButton';

export type CodeLearningTab = 'learn' | 'review' | 'guide';

/** Older saved development-Lead selections return to the learning interface. */
export function restoredCodeLearningTab(saved: string | null): CodeLearningTab {
  return saved === 'review' || saved === 'guide' ? saved : 'learn';
}

export function CodeLearningTabs({ value, onChange }: { value: CodeLearningTab; onChange: (tab: CodeLearningTab) => void }): ReactNode {
  return <div className="code-side-panel-tabs" role="tablist" aria-label="Code assistance">
    {([{ id: 'learn', label: 'Learn' }, { id: 'review', label: 'Review' }, { id: 'guide', label: 'Guided Build' }] as const).map((tab) => <UiButton key={tab.id} type="button" role="tab" aria-selected={value === tab.id} className={value === tab.id ? 'active' : ''} onClick={() => onChange(tab.id)}>{tab.label}</UiButton>)}
  </div>;
}
