import type { LearningProgress } from '@kai/contracts';

export interface ProjectLesson { id: string; title: string; prompt: string; filePath?: string }

/** Build a bounded path from the actual file inventory and recorded learning evidence. */
export function projectLessons(files: readonly string[], progress: LearningProgress | null): ProjectLesson[] {
  const lessons: ProjectLesson[] = [];
  const completed = (progress?.lessons ?? []).filter((lesson) => lesson.explainBack?.verdict === 'solid');
  const practisedConcepts = new Set(completed.flatMap((lesson) => lesson.response.concepts.map((concept) => `${concept.category}:${concept.name}`)));
  const completedFiles = new Set(completed.map((lesson) => lesson.filePath).filter((path): path is string => Boolean(path)));
  for (const concept of [...(progress?.concepts ?? [])].filter((item) => item.mastery !== 'independent' && !practisedConcepts.has(`${item.category}:${item.name}`)).sort((a, b) => a.score - b.score).slice(0, 3)) {
    lessons.push({ id: concept.id, title: `Practise ${concept.name}`, prompt: concept.nextStep || `Help me practise ${concept.name} in this project.` });
  }
  const groups = [
    { title: 'Orient yourself', match: /(?:^|\/)README(?:\.[^/]+)?$/i, task: 'Explain the project purpose and setup using' },
    { title: 'Trace the entry point', match: /(?:^|\/)(?:main|index|app|manage)\.(?:[cm]?[jt]sx?|py|go|rs)$/i, task: 'Help me trace the execution path starting in' },
    { title: 'Understand project configuration', match: /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/, task: 'Explain the dependencies and available checks in' },
    { title: 'Verify a behaviour', match: /(?:\.(?:test|spec)\.|(?:^|\/)(?:tests?|__tests__|specs?)\/)/i, task: 'Help me understand a behaviour tested in' },
  ];
  for (const group of groups) {
    const filePath = files.find((file) => group.match.test(file) && !completedFiles.has(file) && !progress?.recentEvidence.some((evidence) => evidence.filePath === file && evidence.mastery === 'independent'));
    if (filePath) lessons.push({ id: filePath, title: group.title, filePath, prompt: `${group.task} ${filePath}. Give me one small exercise.` });
  }
  const unexplored = files.find((file) => !completedFiles.has(file));
  if (!lessons.length && unexplored) lessons.push({ id: unexplored, title: 'Explore a project file', filePath: unexplored, prompt: `Explain the role of ${unexplored} and give me a small exercise.` });
  return lessons;
}
