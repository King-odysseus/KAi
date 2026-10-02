import { useCallback, useState, type ReactNode } from 'react';
import { ContextPanel } from './Workspace';
import { BuildProgressPanel } from './BuildProgressPanel';

/** RightPane shows the ContextPanel's props through unchanged; it only adds a tab strip above them. */
type ContextProps = Parameters<typeof ContextPanel>[0];

const STORAGE_KEY = 'kai.rightPane.tab';
type Tab = 'context' | 'build';

function useRightPaneTab(): [Tab, (next: Tab) => void] {
  const [tab, setTab] = useState<Tab>(() => {
    try { return window.localStorage.getItem(STORAGE_KEY) === 'build' ? 'build' : 'context'; } catch { return 'context'; }
  });
  const choose = useCallback((next: Tab) => {
    setTab(next);
    // A window with storage locked down keeps the choice in memory instead of failing the click.
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* memory only */ }
  }, []);
  return [tab, choose];
}

/**
 * The right pane: the project's context, and how far through its board the build is.
 *
 * Both panes stay mounted and the inactive one is hidden, because the Build tab is what knows a build is running — if
 * it unmounted whenever Context was showing, the marker telling the person to look would never appear.
 */
export function RightPane(props: ContextProps): ReactNode {
  const [tab, setTab] = useRightPaneTab();
  const [building, setBuilding] = useState(false);

  return (
    <aside className="context-panel">
      <div className="context-tabs" role="tablist" aria-label="Right pane">
        <button type="button" role="tab" aria-selected={tab === 'context'} className={tab === 'context' ? 'active' : ''} onClick={() => setTab('context')}>
          Context
        </button>
        <button type="button" role="tab" aria-selected={tab === 'build'} className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>
          Build{building ? <span className="context-tab-live" aria-label="a build is running" /> : null}
        </button>
      </div>
      <div className="context-pane-body" role="tabpanel">
        <div className="context-pane" hidden={tab !== 'context'}>
          <ContextPanel {...props} />
        </div>
        <div className="context-pane" hidden={tab !== 'build'}>
          <BuildProgressPanel
            projectId={props.activeProject?.id ?? null}
            conversationId={props.conversation?.id ?? null}
            onBuildingChange={setBuilding}
          />
        </div>
      </div>
    </aside>
  );
}
