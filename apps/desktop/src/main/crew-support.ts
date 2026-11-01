import { z } from 'zod';
import { crewConfigSchema } from '@kai/contracts';
import type { CrewConfig, CrewDesign } from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const defaultsSchema = z
  .object({ schemaVersion: z.literal(1), global: crewConfigSchema.nullable(), projects: z.record(z.string(), crewConfigSchema) })
  .strict();

type Saved = z.infer<typeof defaultsSchema>;
const emptySaved = (): Saved => ({ schemaVersion: 1, global: null, projects: {} });

export interface CrewSupportPorts {
  /** What open-pencil holds, without launching it. */
  designStatus?(): Promise<CrewDesign>;
  /** Opens open-pencil when it is not already open. */
  designEnsure?(): Promise<void>;
}

/**
 * What the Crew screen needs besides the runner: the developer's saved crew defaults, and a look at Open Pencil for
 * the Design tab. (How the developer builds is the convention service's job, not the crew's: it serves every run.)
 */
export class CrewSupport {
  private readonly store: AtomicJsonStore<Saved>;
  private tail: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem, private readonly ports: CrewSupportPorts = {}) {
    this.store = new AtomicJsonStore({ filePath, fileSystem, schema: defaultsSchema, defaultValue: emptySaved });
  }

  /** The project's own saved defaults, else the shared ones, else null (the built-in roles). */
  async defaults(projectId?: string): Promise<CrewConfig | null> {
    await this.tail;
    const saved = await this.store.load().catch(emptySaved);
    return (projectId ? saved.projects[projectId] : undefined) ?? saved.global;
  }

  saveDefaults(projectId: string | undefined, config: CrewConfig | null): Promise<CrewConfig | null> {
    const result = this.tail.then(async () => {
      const saved = await this.store.load().catch(emptySaved);
      const projects = { ...saved.projects };
      if (projectId) {
        if (config) projects[projectId] = config;
        else delete projects[projectId];
        await this.store.save({ schemaVersion: 1, global: saved.global, projects });
      } else {
        await this.store.save({ schemaVersion: 1, global: config, projects });
      }
      return config;
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Open Pencil's state and pages. With `launch` the editor is opened first, so a closed editor is not a dead end. */
  async design(launch = false): Promise<CrewDesign> {
    if (launch) await this.ports.designEnsure?.().catch(() => undefined);
    return (await this.ports.designStatus?.().catch(() => null)) ?? { state: 'not-configured', pages: [] };
  }
}
