import { Minus, Plus, Terminal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, clampScale, type Appearance, type Density } from '../appearance';
import { Pill } from './Pill';
import { UiButton } from './UiButton';

/**
 * The thin bar along the bottom, like VS Code's: what will run the next message (agent, model, effort), whether
 * anything is running, and the two things a person adjusts to make the screen comfortable. Everything on it is
 * small and quiet; a badge appears only when something is waiting for the person.
 */
export function StatusBar({
  project,
  agent,
  model,
  effort,
  runningCount,
  agentTerminals,
  terminalOpen,
  appearance,
  onAppearance,
  onOpenPalette,
  onToggleTerminal,
}: {
  project: string | null;
  agent: string;
  model: string;
  effort: string | null;
  runningCount: number;
  /** Shells an agent opened in the terminal while it was closed. */
  agentTerminals: number;
  terminalOpen: boolean;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  onOpenPalette: () => void;
  onToggleTerminal: () => void;
}): ReactNode {
  const [sizeOpen, setSizeOpen] = useState(false);
  const densities: Array<{ id: Density; label: string }> = [
    { id: 'compact', label: 'Compact' },
    { id: 'default', label: 'Default' },
    { id: 'comfortable', label: 'Comfortable' },
  ];
  return (
    <footer className="status-bar" aria-label="Status bar">
      <div className="status-bar-group">
        {project && <span className="status-item" title="Project in this window">{project}</span>}
        <UiButton type="button" className="status-item status-button" onClick={onOpenPalette} title="What runs your next message. Open the command palette to change it.">
          <span className="status-label">{agent}{model ? ` · ${model}` : ''}{effort ? ` · ${effort}` : ''}</span>
        </UiButton>
        <span className={`status-item ${runningCount > 0 ? 'status-running' : ''}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {runningCount > 0 ? `${runningCount} running` : 'Idle'}
        </span>
      </div>
      <div className="status-bar-group">
        <UiButton type="button" className={`status-item status-button ${terminalOpen ? 'active' : ''}`} onClick={onToggleTerminal} title={agentTerminals > 0 ? `${agentTerminals} agent terminal${agentTerminals === 1 ? '' : 's'} running. Open the terminal to see ${agentTerminals === 1 ? 'it' : 'them'}.` : 'Show or hide the terminal'}>
          <Terminal size={12} />
          <span>Terminal</span>
          {agentTerminals > 0 && <Pill tone="info" aria-label={`${agentTerminals} agent terminals`}>{agentTerminals}</Pill>}
        </UiButton>
        <div className="status-popover-wrap">
          <UiButton type="button" className="status-item status-button" aria-haspopup="dialog" aria-expanded={sizeOpen} onClick={() => setSizeOpen((open) => !open)} title="Text size and spacing">
            Aa {appearance.textScale}%
          </UiButton>
          {sizeOpen && (
            <div className="status-popover" role="dialog" aria-label="Text size and spacing" onMouseLeave={() => setSizeOpen(false)}>
              <div className="status-popover-row">
                <span>Text size</span>
                <div className="status-stepper">
                  <UiButton type="button" aria-label="Smaller text" disabled={appearance.textScale <= TEXT_SCALE_MIN} onClick={() => onAppearance({ ...appearance, textScale: clampScale(appearance.textScale - 5) })}><Minus size={12} /></UiButton>
                  <output>{appearance.textScale}%</output>
                  <UiButton type="button" aria-label="Larger text" disabled={appearance.textScale >= TEXT_SCALE_MAX} onClick={() => onAppearance({ ...appearance, textScale: clampScale(appearance.textScale + 5) })}><Plus size={12} /></UiButton>
                </div>
              </div>
              <div className="status-popover-row">
                <span>Spacing</span>
                <div className="status-segment" role="group" aria-label="Spacing">
                  {densities.map((item) => (
                    <UiButton key={item.id} type="button" aria-pressed={appearance.density === item.id} className={appearance.density === item.id ? 'active' : ''} onClick={() => onAppearance({ ...appearance, density: item.id })}>{item.label}</UiButton>
                  ))}
                </div>
              </div>
              <UiButton type="button" className="status-reset" onClick={() => onAppearance({ textScale: 100, density: 'compact' })}>Reset</UiButton>
              <small>Ctrl plus and Ctrl minus change the size, Ctrl 0 resets it.</small>
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
