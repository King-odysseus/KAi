import {
  ARTIFACT_KINDS,
  ARTIFACT_PATHS,
  ARTIFACT_SPEC_PATHS,
  STUDIO_ARTIFACTS_PATH,
  createStudioArtifacts,
  directDependencies,
  dependentsOf,
  studioArtifactsSchema,
  type ArtifactEntry,
  type ArtifactKind,
  // The catalog's shape, aliased so it does not collide with the class of the same name below.
  type StudioArtifacts as StudioCatalog,
} from '@kai/contracts';
import type { SpecStore } from './spec-store';

/**
 * The artifact catalog. Every `.kai/spec` artifact is one plain file, and `artifacts.json` is the index that says
 * what exists, what wrote it, and whether it is stale. This is the only place the dependency table is applied, so
 * "regenerating the PRD flags the stories stale" is a fact in code rather than a hope in a prompt.
 *
 * `artifacts.json` itself is written by code, never by a model.
 */

const SEED_BY: Partial<Record<ArtifactKind, string>> = { brief: 'the Project Studio interview' };

export interface ArtifactPorts {
  spec: SpecStore;
  projectRoot(projectId: string): Promise<string>;
  now(): string;
}

/** The catalog after `kind` is (re)written: that entry is fresh, and everything that reads it goes stale. */
export function applyWrite(
  entries: readonly ArtifactEntry[],
  kind: ArtifactKind,
  info: { version: number; at: string; generatedBy: string },
): ArtifactEntry[] {
  const existing = new Map(entries.map((entry) => [entry.kind, entry]));
  existing.set(kind, {
    kind,
    path: ARTIFACT_PATHS[kind],
    version: info.version,
    updatedAt: info.at,
    generatedBy: info.generatedBy,
    dependsOn: directDependencies(kind),
    stale: false,
    staleReason: null,
  });
  for (const dependent of dependentsOf(kind)) {
    const entry = existing.get(dependent);
    if (entry) existing.set(dependent, { ...entry, stale: true, staleReason: `${kind} was regenerated.` });
  }
  return ARTIFACT_KINDS.flatMap((candidate) => (existing.has(candidate) ? [existing.get(candidate)!] : []));
}

/**
 * The catalog with a `brief` entry guaranteed, so the interview's brief shows up without a second write path. This
 * only *records* the brief: it is not a regeneration, so nothing that reads the brief is marked stale here.
 */
export function ensureBrief(entries: readonly ArtifactEntry[], briefExists: boolean, at: string): ArtifactEntry[] {
  if (!briefExists || entries.some((entry) => entry.kind === 'brief')) return [...entries];
  const brief: ArtifactEntry = {
    kind: 'brief',
    path: ARTIFACT_PATHS.brief,
    version: 0,
    updatedAt: at,
    generatedBy: SEED_BY.brief ?? 'code',
    dependsOn: [],
    stale: false,
    staleReason: null,
  };
  return ARTIFACT_KINDS.flatMap((kind) => (kind === 'brief' ? [brief] : entries.filter((entry) => entry.kind === kind)));
}

/** Marks artifacts stale whose dependency was edited by hand, since nothing regenerated them to catch up. */
export function markUserEdited(entries: readonly ArtifactEntry[], kind: ArtifactKind, at: string): ArtifactEntry[] {
  const existing = new Map(entries.map((entry) => [entry.kind, entry]));
  const current = existing.get(kind);
  if (current) existing.set(kind, { ...current, generatedBy: 'user', updatedAt: at, stale: false, staleReason: null });
  for (const dependent of dependentsOf(kind)) {
    const entry = existing.get(dependent);
    if (entry) existing.set(dependent, { ...entry, stale: true, staleReason: `${kind} was edited by hand.` });
  }
  return ARTIFACT_KINDS.flatMap((candidate) => (existing.has(candidate) ? [existing.get(candidate)!] : []));
}

export class StudioArtifacts {
  constructor(private readonly ports: ArtifactPorts) {}

  /** The catalog, reconciled with what is actually on disk: a brief written by the interview is adopted here. */
  async read(projectId: string): Promise<StudioCatalog> {
    const root = await this.ports.projectRoot(projectId);
    const stored = await this.load(root);
    const briefExists = (await this.ports.spec.read(root, ARTIFACT_SPEC_PATHS.brief)) !== null;
    const artifacts = ensureBrief(stored.artifacts, briefExists, this.ports.now());
    return artifacts === stored.artifacts ? stored : { schemaVersion: 1, artifacts };
  }

  /** Reads one artifact's text, or null when it has not been written yet. */
  async readText(projectId: string, kind: ArtifactKind): Promise<string | null> {
    return this.ports.spec.read(await this.ports.projectRoot(projectId), ARTIFACT_SPEC_PATHS[kind]);
  }

  /** Any file under `.kai/spec` that is not one of the catalogued artifacts, such as the style reference notes. */
  async readSpecText(projectId: string, relativePath: string): Promise<string | null> {
    return this.ports.spec.read(await this.ports.projectRoot(projectId), relativePath);
  }

  /**
   * Writes one artifact and updates the catalog. The file goes through the spec store, so the copy it replaced is
   * kept under `.history` and every artifact that reads this one is flagged stale.
   */
  async write(projectId: string, kind: ArtifactKind, content: string, generatedBy: string): Promise<StudioCatalog> {
    const root = await this.ports.projectRoot(projectId);
    const written = await this.ports.spec.write(root, ARTIFACT_SPEC_PATHS[kind], content);
    const next = applyWrite((await this.load(root)).artifacts, kind, {
      version: written.version,
      at: this.ports.now(),
      generatedBy,
    });
    await this.save(root, next);
    // Answer with the reconciled catalog, so a caller never sees the brief missing from it.
    return this.read(projectId);
  }

  /** Records that the user edited an artifact by hand, so its dependents are shown as stale rather than trusted. */
  async markEdited(projectId: string, kind: ArtifactKind): Promise<StudioCatalog> {
    const root = await this.ports.projectRoot(projectId);
    const next = markUserEdited((await this.load(root)).artifacts, kind, this.ports.now());
    await this.save(root, next);
    return this.read(projectId);
  }

  /** Every file the studio has written under `.kai/spec`, for a UI that shows what exists without guessing. */
  async files(projectId: string): Promise<string[]> {
    return this.ports.spec.list(await this.ports.projectRoot(projectId));
  }

  private async load(root: string): Promise<StudioCatalog> {
    const raw = await this.ports.spec.read(root, STUDIO_ARTIFACTS_PATH);
    if (raw === null) return createStudioArtifacts();
    try {
      const parsed = studioArtifactsSchema.safeParse(JSON.parse(raw));
      // A hand-edited catalog is reported as empty rather than repaired: these are the user's files.
      return parsed.success ? parsed.data : createStudioArtifacts();
    } catch {
      return createStudioArtifacts();
    }
  }

  private async save(root: string, artifacts: ArtifactEntry[]): Promise<void> {
    await this.ports.spec.write(root, STUDIO_ARTIFACTS_PATH, `${JSON.stringify({ schemaVersion: 1, artifacts }, null, 2)}\n`);
  }
}
