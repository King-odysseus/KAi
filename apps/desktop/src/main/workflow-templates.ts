import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  workflowTemplateSaveInputSchema,
  workflowTemplateSchema,
  type WorkflowTemplate,
  type WorkflowTemplateSaveInput,
} from '@kai/contracts';

export class WorkflowTemplateStore {
  constructor(private readonly root: string) {}

  async list(projectId?: string): Promise<WorkflowTemplate[]> {
    const directory = this.directory(projectId);
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch {
      return [];
    }
    const templates: WorkflowTemplate[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        templates.push(workflowTemplateSchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))));
      } catch {
        // Ignore incomplete or invalid template files.
      }
    }
    return templates.sort((left, right) => left.name.localeCompare(right.name));
  }

  async save(input: WorkflowTemplateSaveInput): Promise<WorkflowTemplate> {
    const parsed = workflowTemplateSaveInputSchema.parse(input);
    const now = new Date().toISOString();
    const template = workflowTemplateSchema.parse({
      ...parsed,
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
    });
    const directory = this.directory(undefined);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${safeId(template.id)}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, target);
    return template;
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    try {
      await fs.unlink(path.join(this.directory(undefined), `${safeId(id)}.json`));
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }

  private directory(_projectId?: string): string {
    return this.root;
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid workflow template id.');
  return value;
}
