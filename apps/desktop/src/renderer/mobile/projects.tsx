import { type ReactNode } from 'react';
import { ago } from './views';
import { TopBar } from './chrome';
import type { RemoteState } from './store';

/**
 * The projects open on the desktop, with what each one has been doing. Tapping one opens its Studio
 * board, which is the only thing about a project a phone can act on: there is no way from here to
 * choose, open or remove a project — those are desktop dialog-and-disk operations, and none is on the
 * remote allowlist.
 */
export function Projects({ state, onOpenStudio }: { state: RemoteState; onOpenStudio: (projectId: string) => void }): ReactNode {
  const projects = state.bootstrap?.projects ?? [];
  const activeId = state.bootstrap?.activeProjectId ?? null;

  return (
    <>
      <TopBar title="Projects">
        <span className={`dot ${state.connected ? '' : 'off'}`} />
        {`${projects.length} open`}
      </TopBar>
      <div className="scroll">
        {projects.length === 0 && (
          <div className="card">
            <div className="title">No projects open</div>
            <div className="meta">Projects are opened on the desktop. Once one is, its board is readable from here.</div>
          </div>
        )}

        {projects.map((project) => {
          const runs = state.runs.filter((run) => run.projectId === project.id);
          const live = runs.filter((run) => run.workflow.status === 'running').length;
          const cards = state.board?.projectId === project.id ? state.board.cards : null;
          const unfinished = cards?.filter((card) => card.status !== 'done').length ?? null;
          return (
            <button type="button" key={project.id} className={`card ${live > 0 ? 'live' : ''}`} onClick={() => onOpenStudio(project.id)}>
              <div className="row">
                <span className={`chip ${live > 0 ? 'run' : project.id === activeId ? 'done' : 'soft'}`}>
                  {live > 0 ? `${live} running` : project.id === activeId ? 'On screen' : 'Open'}
                </span>
                <span className="meta mono flush">{ago(project.lastOpenedAt)}</span>
              </div>
              <div className="title">{project.name}</div>
              <div className="meta mono">{project.path}</div>
              <div className="meta dim">
                {[
                  `${runs.length} run${runs.length === 1 ? '' : 's'}`,
                  unfinished === null ? null : `${unfinished} card${unfinished === 1 ? '' : 's'} left`,
                ].filter(Boolean).join(' · ')}
              </div>
            </button>
          );
        })}

        {projects.length > 0 && (
          <div className="card">
            <div className="meta dim">Tap a project to read its Studio board. Opening and removing projects stays on the desktop.</div>
          </div>
        )}
      </div>
    </>
  );
}
