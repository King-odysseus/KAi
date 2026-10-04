import { AlertTriangle, Check, Moon } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import {
  studioAttention,
  type AutopilotStatus,
  type GuideAction,
  type StudioArtifacts,
  type StudioBoard,
  type StudioDesign,
  type StudioGuideView,
} from '@kai/contracts';

interface Props {
  board: StudioBoard | null;
  artifacts: StudioArtifacts | null;
  design: StudioDesign | null;
  guide: StudioGuideView | null;
  /** The live run, or null when none has gone for this project. */
  run: AutopilotStatus | null;
  busy: boolean;
  /** The same actions the guide's own buttons run, so the two can never offer different things. */
  onAction: (action: GuideAction) => void;
}

/**
 * The one thing that needs the person, above the board.
 *
 * Autopilot runs unattended, which is the whole point of it and also the reason it can stop without anyone noticing.
 * The board itself says what each card is doing; what it has never said is the one line someone coming back actually
 * needs — is anything waiting on me, and what do I press. That is all this shows, and the rules behind it are in
 * `studioAttention` rather than here, so the banner cannot disagree with the guide that sits under it.
 *
 * It renders nothing when nothing is asked of anyone. A banner that is always there is a banner that stops being read.
 */
export function NeedsYouBanner({ board, artifacts, design, guide, run, busy, onAction }: Props): ReactNode {
  const attention = useMemo(() => {
    if (!board || board.cards.length === 0) return null;
    return studioAttention({
      cards: board.cards,
      writtenArtifacts: artifacts?.artifacts.map((entry) => entry.kind) ?? [],
      designPages: design?.components.filter((component) => component.screen).length ?? 0,
      steps: guide?.steps ?? [],
      run,
    });
  }, [board, artifacts, design, guide, run]);

  if (!attention) return null;

  const Icon = attention.tone === 'needs-you' ? AlertTriangle : attention.tone === 'waiting' ? Moon : Check;
  return (
    <div className={`needs-you tone-${attention.tone}`} role="status">
      <span className="needs-you-icon" aria-hidden="true"><Icon size={15} /></span>
      <div className="needs-you-body">
        <strong>{attention.headline}</strong>
        {attention.detail && <p className="needs-you-detail">{attention.detail}</p>}
      </div>
      {attention.action && attention.actionLabel && (
        <button type="button" className="secondary-button" onClick={() => onAction(attention.action as GuideAction)} disabled={busy}>
          {attention.actionLabel}
        </button>
      )}
    </div>
  );
}
