import { AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type * as Monaco from 'monaco-editor';
import type { TodoScanResult } from '@kai/contracts';
import { FileTypeIcon } from './FileTypeIcon';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';

const baseName = (path: string): string => path.split('/').at(-1) ?? path;
const folderOf = (path: string): string => path.split('/').slice(0, -1).join('/');

function FileLabel({ path }: { path: string }): ReactNode {
  return (
    <>
      <FileTypeIcon name={baseName(path)} size={14} />
      <span className="truncate">{baseName(path)}</span>
      {folderOf(path) && <small className="side-row-dir truncate">{folderOf(path)}</small>}
    </>
  );
}

/** Files opened lately in this project, newest first. */
export function RecentPanel({ paths, activePath, onOpen, onClear }: { paths: readonly string[]; activePath: string | null; onOpen: (path: string) => void; onClear: () => void }): ReactNode {
  if (!paths.length) return <div className="empty-list">Files you open will be listed here, newest first.</div>;
  return (
    <div className="side-list" role="list" aria-label="Recent files">
      {paths.map((path) => (
        <UiButton key={path} type="button" role="listitem" className={`side-row ${path === activePath ? 'active' : ''}`} title={path} onClick={() => onOpen(path)}>
          <FileLabel path={path} />
        </UiButton>
      ))}
      <UiButton type="button" className="secondary-button side-clear" onClick={onClear}>Clear recent files</UiButton>
    </div>
  );
}

/** Every TODO, FIXME, HACK, BUG, XXX and NOTE comment in the project. */
export function TodoPanel({ projectId, onOpen }: { projectId: string; onOpen: (path: string, line: number) => void }): ReactNode {
  const [result, setResult] = useState<TodoScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const scan = useCallback((): void => {
    setLoading(true);
    setError(null);
    void window.kaiDesktop.scanTodos(projectId)
      .then((response) => { if (response.ok) setResult(response.data); else setError(response.error.message); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'The scan failed.'))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => { scan(); }, [scan]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (result?.items ?? []).filter((item) => !needle || `${item.kind} ${item.path} ${item.text}`.toLowerCase().includes(needle));
  }, [result, filter]);

  return (
    <div className="side-list">
      <div className="side-tools">
        <UiTextInput className="side-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter to-dos" aria-label="Filter to-dos" />
        <UiButton type="button" className="icon-button compact" title="Scan again" aria-label="Scan again" disabled={loading} onClick={scan}><RefreshCw size={13} className={loading ? 'spin' : ''} /></UiButton>
      </div>
      {error && <div className="empty-list">{error}</div>}
      {!error && !loading && result && !shown.length && <div className="empty-list">{result.items.length ? 'No to-do matches that filter.' : 'No TODO, FIXME or similar comments in this project.'}</div>}
      {shown.map((item) => (
        <UiButton key={`${item.path}:${item.line}`} type="button" className="side-row todo" title={`${item.path}:${item.line}`} onClick={() => onOpen(item.path, item.line)}>
          <b className={`todo-kind todo-kind-${item.kind.toLowerCase()}`}>{item.kind}</b>
          <span className="truncate">{item.text || '(no text)'}</span>
          <small className="side-row-dir truncate">{baseName(item.path)}:{item.line}</small>
        </UiButton>
      ))}
      {result?.truncated && <div className="settings-note">Showing the first {result.items.length} to-dos.</div>}
    </div>
  );
}

interface Problem { path: string; line: number; column: number; message: string; severity: 'error' | 'warning' }

/** Errors and warnings in the files open in the editor. A file that is not open has not been checked. */
export function ProblemsPanel({ monaco, onOpen, onCount }: { monaco: typeof Monaco | null; onOpen: (path: string, line: number, column: number) => void; onCount?: (count: number) => void }): ReactNode {
  const [problems, setProblems] = useState<Problem[]>([]);

  useEffect(() => {
    if (!monaco) return undefined;
    const read = (): void => {
      const found: Problem[] = [];
      for (const marker of monaco.editor.getModelMarkers({})) {
        if (marker.severity < monaco.MarkerSeverity.Warning || marker.resource.scheme !== 'file') continue;
        found.push({
          path: marker.resource.path.replace(/^\//, ''),
          line: marker.startLineNumber,
          column: marker.startColumn,
          message: marker.message.replace(/\s+/g, ' '),
          severity: marker.severity >= monaco.MarkerSeverity.Error ? 'error' : 'warning',
        });
      }
      found.sort((a, b) => (a.severity === b.severity ? a.path.localeCompare(b.path) || a.line - b.line : a.severity === 'error' ? -1 : 1));
      setProblems(found.slice(0, 500));
    };
    read();
    const subscription = monaco.editor.onDidChangeMarkers(read);
    return () => subscription.dispose();
  }, [monaco]);

  useEffect(() => { onCount?.(problems.length); }, [problems.length, onCount]);

  if (!problems.length) return <div className="empty-list">No errors or warnings in the open files. Files that are not open have not been checked.</div>;
  return (
    <div className="side-list" role="list" aria-label="Problems">
      {problems.map((problem, index) => (
        <UiButton key={`${problem.path}:${problem.line}:${problem.column}:${index}`} type="button" role="listitem" className={`side-row problem ${problem.severity}`} title={problem.message} onClick={() => onOpen(problem.path, problem.line, problem.column)}>
          {problem.severity === 'error' ? <AlertCircle size={13} className="problem-icon" /> : <AlertTriangle size={13} className="problem-icon" />}
          <span className="truncate">{problem.message}</span>
          <small className="side-row-dir truncate">{baseName(problem.path)}:{problem.line}</small>
        </UiButton>
      ))}
    </div>
  );
}
