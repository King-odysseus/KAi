import type { LearningProgress } from '@kai/contracts';

export interface ProjectLesson { id: string; title: string; prompt: string; filePath?: string }

/** Build a bounded path from the actual file inventory and recorded learning evidence. */
export function projectLessons(files: readonly string[], progress: LearningProgress | null): ProjectLesson[] {
  const lessons: ProjectLesson[] = [];
  for (const concept of [...(progress?.concepts ?? [])].filter((item) => item.mastery !== 'independent').sort((a, b) => a.score - b.score).slice(0, 3)) {
    lessons.push({ id: concept.id, title: `Practise ${concept.name}`, prompt: concept.nextStep || `Help me practise ${concept.name} in this project.` });
  }
  const groups = [
    { title: 'Orient yourself', match: /(?:^|\/)README(?:\.[^/]+)?$/i, task: 'Explain the project purpose and setup using' },
    { title: 'Trace the entry point', match: /(?:^|\/)(?:main|index|app|manage)\.(?:[cm]?[jt]sx?|py|go|rs)$/i, task: 'Help me trace the execution path starting in' },
    { title: 'Understand project configuration', match: /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/, task: 'Explain the dependencies and available checks in' },
    { title: 'Verify a behaviour', match: /(?:\.(?:test|spec)\.|(?:^|\/)(?:tests?|__tests__|specs?)\/)/i, task: 'Help me understand a behaviour tested in' },
  ];
  for (const group of groups) {
    const filePath = files.find((file) => group.match.test(file) && !progress?.recentEvidence.some((evidence) => evidence.filePath === file && evidence.mastery === 'independent'));
    if (filePath) lessons.push({ id: filePath, title: group.title, filePath, prompt: `${group.task} ${filePath}. Give me one small exercise.` });
  }
  if (!lessons.length && files[0]) lessons.push({ id: files[0], title: 'Explore a project file', filePath: files[0], prompt: `Explain the role of ${files[0]} and give me a small exercise.` });
  return lessons;
}
