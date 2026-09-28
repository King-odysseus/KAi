import { useEffect, useState, type ReactNode } from 'react';
import type { BoardTask, TaskColumn } from '@kai/contracts';
import { TopBar } from './chrome';
import { loadTasks, type RemoteState } from './store';

/** The same three columns the desktop's Tasks page uses, in the order work moves through them. */
const COLUMNS: Array<{ id: TaskColumn; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

function taskChip(task: BoardTask): string {
  if (task.column === 'done') return 'done';
  if (task.column === 'doing') return 'run';
  return 'soft';
}

function holder(task: BoardTask): string {
  if (task.claimedBy) return `Held by ${task.claimedBy}`;
  if (task.assignee) return `For ${task.assignee}`;
  if (task.creator) return `From ${task.creator}`;
  return '';
}

/**
 * The C1 brain's task board, read-only. The desktop's Tasks page starts and completes tasks; this screen
 * deliberately cannot, and says so, because starting a task on the desktop opens a conversation and runs
 * an agent — a write the phone has no door to. What it does is answer "what is left", from anywhere.
 */
export function Tasks({ state }: { state: RemoteState }): ReactNode {
  const [filter, setFilter] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const tasks = state.tasks;

  useEffect(() => {
    if (tasks) return;
    void loadTasks().catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'The task board could not be read.');
    });
  }, [tasks]);

  const all = tasks ?? [];
  const projects = [...new Set(all.map((task) => task.project).filter(Boolean))];
  const shown = filter ? all.filter((task) => task.project === filter) : all;
  const open = all.filter((task) => task.column !== 'done').length;

  return (
    <>
      <TopBar title="Tasks">
        <span className={`dot ${state.connected ? '' : 'off'}`} />
        {tasks ? `${open} open` : 'reading…'}
      </TopBar>
      <div className="scroll">
        {problem && (
          <div className="card">
            <div className="title">Could not read the task board</div>
            <div className="meta">{problem}</div>
            <div className="meta dim">Tasks live in the C1 brain, so this needs the brain running on the desktop.</div>
          </div>
        )}

        {projects.length > 1 && (
          <div className="filters">
            <button type="button" className={filter === null ? 'on' : ''} onClick={() => setFilter(null)}>All projects</button>
            {projects.map((name) => (
              <button type="button" key={name} className={filter === name ? 'on' : ''} onClick={() => setFilter(name)}>{name}</button>
            ))}
          </div>
        )}

        {!problem && tasks && all.length === 0 && (
          <div className="card">
            <div className="title">No tasks</div>
            <div className="meta">The shared to-do list is empty. Tasks are added on the desktop, or by an agent as it works.</div>
          </div>
        )}

        {COLUMNS.map((column) => {
          const cards = shown.filter((task) => task.column === column.id);
          if (cards.length === 0) return null;
          return (
            <div className="stack" key={column.id}>
              <div className="section-head">{column.label} · {cards.length}</div>
              {cards.map((task) => (
                <div className="card" key={`${task.project}:${task.title}`}>
                  <div className="row">
                    <span className={`chip ${taskChip(task)}`}>{task.project || 'no project'}</span>
                    {task.subtasksTotal > 0 && (
                      <span className="meta mono flush">{task.subtasksDone}/{task.subtasksTotal}</span>
                    )}
                  </div>
                  <div className="title">{task.title}</div>
                  {task.description && (
                    <div className="meta">
                      {task.description.length > 180 ? `${task.description.slice(0, 180)}…` : task.description}
                    </div>
                  )}
                  <div className="meta dim">
                    {[holder(task), task.tags, task.dependsOn ? `needs "${task.dependsOn}" first` : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          );
        })}

        {all.length > 0 && (
          <div className="card">
            <div className="meta dim">
              This board is a read of the C1 brain. Starting, claiming and completing a task stays on the desktop.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
