export const FIRST_RUN_PROJECT_TYPES = ['Web app', 'Mobile app', 'API or service', 'Automation or tool', 'Other'] as const;

export function firstRunIdea(projectType: string, description: string): string {
  return `Project type: ${projectType}\n\n${description.trim()}`;
}
