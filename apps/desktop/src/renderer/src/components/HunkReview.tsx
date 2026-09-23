import { Undo2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { diffHunks } from '@kai/contracts';

// The review sends at most this many characters per side; a cut-off file would number its hunks differently from disk.
const MAX_REVIEW_CHARACTERS = 190_000;

export function canReviewHunks(before: string, after: string): boolean {
  return before.length < MAX_REVIEW_CHARACTERS && after.length < MAX_REVIEW_CHARACTERS;
}

const stripEnding = (line: string): string => line.replace(/\r?\n$/, '');

/** Each hunk can be kept (do nothing) or rejected, which puts that part of the file back as it was. */
export function HunkReview({ before, after, disabled, onReject }: { before: string; after: string; disabled: boolean; onReject: (hunkId: number) => void }): ReactNode {
  const hunks = useMemo(() => diffHunks(before, after), [before, after]);
  if (hunks.length === 0) return <div className="empty-list">No line changes</div>;
  return (
    <div className="hunk-list">
      {hunks.map((hunk) => (
        <section key={hunk.id} className="hunk">
          <div className="hunk-head">
            <span>Line {hunk.newStart}{hunk.removed.length > 0 ? ` (was ${hunk.oldStart})` : ''}</span>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => onReject(hunk.id)}><Undo2 size={12} /><span>Reject hunk</span></button>
          </div>
          <pre className="hunk-body">
            {hunk.contextBefore.map((line, index) => <div key={`b${index}`} className="hunk-line context">{'  '}{stripEnding(line)}</div>)}
            {hunk.removed.map((line, index) => <div key={`r${index}`} className="hunk-line removed">{'- '}{stripEnding(line)}</div>)}
            {hunk.added.map((line, index) => <div key={`a${index}`} className="hunk-line added">{'+ '}{stripEnding(line)}</div>)}
            {hunk.contextAfter.map((line, index) => <div key={`c${index}`} className="hunk-line context">{'  '}{stripEnding(line)}</div>)}
          </pre>
        </section>
      ))}
    </div>
  );
}
