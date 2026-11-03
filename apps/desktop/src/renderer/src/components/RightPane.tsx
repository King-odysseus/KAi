import { useCallback, useState, type ReactNode } from 'react';
import { ContextPanel } from './Workspace';
import { BuildProgressPanel } from './BuildProgressPanel';
import { TabBar } from './ui/TabBar';

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
      <TabBar
        label="Right pane"
        value={tab}
        onChange={setTab}
        className="!px-2"
        tabs={[
          { id: 'context', label: 'Context' },
          { id: 'build', label: <>Build{building ? <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--running)]" aria-label="a build is running" /> : null}</> },
        ]}
      />
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
