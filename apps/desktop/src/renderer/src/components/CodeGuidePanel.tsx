import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentCapability, AgentId, CodeGuideAction, CodeGuideView, ConversationRecord, GuidedBuild } from '@kai/contracts';
import { UiButton } from './UiButton';
import { GuidedBuildLearnPanel } from './GuidedBuildLearnPanel';
import type { GuidedRunOverride } from './guided-build-engine';

interface Props {
  view: CodeGuideView | null;
  explaining: boolean;
  busy: boolean;
  error?: string | null;
  onExplain: () => void;
  onAction: (action: CodeGuideAction) => void;
  stripHidden: boolean;
  onToggleStrip: () => void;
  guidedBuild?: GuidedBuild | null;
  conversation: ConversationRecord | null;
  agentCapabilities: readonly AgentCapability[];
  selectedAgent: AgentId;
  onUpdateGuidedBuild: (build: GuidedBuild) => void;
  onRunGuidedBuild: (prompt: string, build: GuidedBuild, mode: 'coach' | 'plan' | 'review' | 'show-code' | 'write-code', userMessage?: string, override?: GuidedRunOverride) => void | Promise<void>;
  projectId: string | null;
  modelSettings?: Pick<import('@kai/contracts').AppSettings, 'directApi' | 'savedLocalModels'>;
  onOpenFile: (path: string, line?: number) => void;
}

export function CodeGuidePanel(props: Props): ReactNode {
  return <GuidedBuildLearnPanel {...props} error={props.error ?? null} guidedBuild={props.guidedBuild ?? null} />;
}
/**
 * The same answer in one line, pinned above the editor.
 *
 * This is the half that matters while you are actually typing: the panel above is behind a tab, and a guide you have
 * to go and open is a guide you will not read. It is deliberately not tied to the Learn panel being open, for the
 * same reason — the moment it is most useful is the moment the panel is closed.
 */
export function CodeGuideStrip({ view, busy, onAction, onOpen, onDismiss }: { view: CodeGuideView | null; busy: boolean; onAction: (action: CodeGuideAction) => void; onOpen: () => void; onDismiss: () => void }): ReactNode {
  if (!view) return null;
  const current = view.steps.find((step) => step.id === view.currentStepId);
  if (!current) return null;
  const position = view.steps.indexOf(current) + 1;
  return (
    <div className={`guide-strip ${current.state}`}>
      <span className="guide-strip-where">
        Step {position} of {view.steps.length}
      </span>
      <strong>{current.title}</strong>
      <span className="guide-strip-detail">{current.detail}</span>
      <span className="guide-strip-actions">
        {/* Unlike the board's strip, every action here is kept: "Open Learn" is worth offering from the strip
            precisely because it is what you would otherwise have to go looking for. */}
        {current.action && current.actionLabel && (
          <UiButton type="button" className="secondary-button" onClick={() => onAction(current.action as CodeGuideAction)} disabled={busy}>{current.actionLabel}</UiButton>
        )}
        <UiButton type="button" className="link-button" onClick={onOpen}>Open the guide</UiButton>
        <UiButton type="button" className="icon-button compact" aria-label="Hide guide bar" title="Hide guide bar" onClick={onDismiss}><X size={13} /></UiButton>
      </span>
    </div>
  );
}
