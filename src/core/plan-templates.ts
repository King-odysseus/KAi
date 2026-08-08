import * as fs from 'fs/promises';
import * as path from 'path';
import type { Plan } from './plan';

export interface PlanTemplate {
  name: string;
  description: string;
  steps: Array<{ agent: string; prompt: string; label?: string }>;
  route: string;
  autonomy: string;
}

export async function savePlanTemplate(plansDir: string, template: PlanTemplate): Promise<void> {
  await fs.mkdir(plansDir, { recursive: true });
  const fileName = template.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  await fs.writeFile(path.join(plansDir, fileName), JSON.stringify(template, null, 2), 'utf8');
}

export async function listPlanTemplates(plansDir: string): Promise<PlanTemplate[]> {
  try {
    const files = await fs.readdir(plansDir);
    const templates: PlanTemplate[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(plansDir, file), 'utf8');
        templates.push(JSON.parse(content) as PlanTemplate);
      } catch { /* skip invalid files */ }
    }
    return templates.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function deletePlanTemplate(plansDir: string, name: string): Promise<void> {
  const fileName = name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  await fs.unlink(path.join(plansDir, fileName));
}

export function templateToPlan(template: PlanTemplate, route?: string, autonomy?: string): Plan {
  const { createPlan } = require('./plan');
  return createPlan(
    template.name,
    template.steps.map((s, i) => ({ ...s, label: s.label || `Step ${i + 1}` })),
    (route || template.route) as any,
    (autonomy || template.autonomy) as any,
  );
}
