import type { ReactNode } from 'react';
import { CHANGE_BADGE, describeChange, type FileChange } from './project-files-tree';

/** Whether a change is in the next commit. Untracked files and conflicts have no staged state to show. */
export function stageState(change: FileChange): 'staged' | 'partly-staged' | 'unstaged' | '' {
  if (change.kind === 'untracked' || change.kind === 'conflict') return '';
  if (change.staged && change.unstaged) return 'partly-staged';
  return change.staged ? 'staged' : 'unstaged';
}

/** The one-letter Git badge: its colour says what changed, its fill whether the change is staged. */
export function GitBadge({ change }: { change: FileChange }): ReactNode {
  const description = describeChange(change);
  return (
    <i className={`files-badge ${change.kind} ${stageState(change)}`} title={description} aria-label={description}>
      <span>{CHANGE_BADGE[change.kind]}</span>
    </i>
  );
}
