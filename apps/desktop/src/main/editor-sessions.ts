import type { EditorDocumentState, EditorSavedDocument, EditorWindowSnapshot } from '@kai/contracts';
import { FileConflictError, writeProjectFile } from './project-files';

export interface EditorSessionDocument extends EditorDocumentState {
  updatedAt: string;
}

export interface EditorSessionSaveResult {
  saved: EditorSavedDocument[];
  conflict: string | null;
}

/** Owns dirty editor snapshots per renderer so navigation and window close cannot silently discard work. */
export class EditorSessionManager {
  private readonly byWindow = new Map<number, Map<string, Map<string, EditorSessionDocument>>>();
  private readonly layoutByWindow = new Map<number, Map<string, Pick<EditorWindowSnapshot, 'openPaths' | 'activePath'>>>();

  constructor(private readonly writeFile: typeof writeProjectFile = writeProjectFile) {}

  update(windowId: number, document: EditorDocumentState): void {
    const projects = this.byWindow.get(windowId) ?? new Map<string, Map<string, EditorSessionDocument>>();
    const documents = projects.get(document.projectId) ?? new Map<string, EditorSessionDocument>();
    documents.set(document.path, { ...document, updatedAt: new Date().toISOString() });
    projects.set(document.projectId, documents);
    this.byWindow.set(windowId, projects);
  }

  remove(windowId: number, projectId: string, path: string): void {
    const projects = this.byWindow.get(windowId);
    const documents = projects?.get(projectId);
    documents?.delete(path);
    if (documents?.size === 0) projects?.delete(projectId);
    if (projects?.size === 0) this.byWindow.delete(windowId);
    const layouts = this.layoutByWindow.get(windowId);
    const layout = layouts?.get(projectId);
    if (layout) {
      layout.openPaths = layout.openPaths.filter((candidate) => candidate !== path);
      if (layout.activePath === path) layout.activePath = layout.openPaths.at(-1) ?? null;
      if (layout.openPaths.length === 0) layouts?.delete(projectId);
      if (layouts?.size === 0) this.layoutByWindow.delete(windowId);
    }
  }

  removeWindow(windowId: number): void {
    this.byWindow.delete(windowId);
    this.layoutByWindow.delete(windowId);
  }

  updateWindow(windowId: number, snapshot: EditorWindowSnapshot): void {
    const openPaths = [...new Set(snapshot.openPaths)];
    this.layoutByWindow.set(windowId, new Map([
      ...(this.layoutByWindow.get(windowId) ?? new Map()),
      [snapshot.projectId, {
        openPaths,
        activePath: openPaths.includes(snapshot.activePath ?? '') ? snapshot.activePath : openPaths.at(-1) ?? null,
      }],
    ]));
  }

  snapshot(windowId: number, projectId: string): EditorWindowSnapshot {
    const layout = this.layoutByWindow.get(windowId)?.get(projectId);
    return {
      projectId,
      documents: [...(this.byWindow.get(windowId)?.get(projectId)?.values() ?? [])]
        .map(({ updatedAt: _updatedAt, ...document }) => document),
      openPaths: layout?.openPaths ?? [],
      activePath: layout?.activePath ?? null,
    };
  }

  dirty(windowId: number, projectId?: string): EditorSessionDocument[] {
    const projects = this.byWindow.get(windowId);
    if (!projects) return [];
    const result: EditorSessionDocument[] = [];
    for (const [candidateProjectId, documents] of projects) {
      if (projectId && candidateProjectId !== projectId) continue;
      for (const document of documents.values()) if (document.dirty) result.push(document);
    }
    return result.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** Saves a snapshot only if it still matches what was last reported by the renderer. */
  async saveDirty(
    windowId: number,
    projectRoots: ReadonlyMap<string, string>,
  ): Promise<EditorSessionSaveResult> {
    const saved: EditorSavedDocument[] = [];
    for (const document of this.dirty(windowId)) {
      const projectRoot = projectRoots.get(document.projectId);
      if (!projectRoot) return { saved, conflict: 'The project for an unsaved document is no longer available.' };
      try {
        const written = await this.writeFile(projectRoot, document.path, document.content, {
          expectedHash: document.expectedHash,
          eol: document.eol,
          bom: document.bom,
        });
        const latest = this.byWindow.get(windowId)?.get(document.projectId)?.get(document.path);
        if (!latest || latest.content !== document.content || latest.expectedHash !== document.expectedHash) {
          return { saved, conflict: `${document.path} changed while KAI was saving it.` };
        }
        latest.expectedHash = written.hash;
        latest.dirty = false;
        latest.updatedAt = new Date().toISOString();
        saved.push({
          projectId: document.projectId,
          path: document.path,
          hash: written.hash,
          mtimeMs: written.mtimeMs,
          size: written.size,
          savedContent: document.content,
        });
      } catch (error) {
        const detail = error instanceof FileConflictError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
        return { saved, conflict: `${document.path}: ${detail}` };
      }
    }
    return { saved, conflict: null };
  }
}
