import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  LearningLessonRecordInput,
  LearningLessonRecordResult,
} from '@kai/contracts';
import { resolveInside } from './project-files';

export async function recordLearningLesson(
  projectRoot: string,
  input: LearningLessonRecordInput,
): Promise<LearningLessonRecordResult> {
  const target = await resolveInside(projectRoot, 'docs/LEARNING_GUIDE.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const entry = lessonEntry(input, existing);
  const separator = existing.trimEnd() ? '\n\n' : '';
  const content = `${existing.trimEnd()}${separator}${entry}\n`;
  await fs.writeFile(target, content, 'utf8');
  return {
    path: 'docs/LEARNING_GUIDE.md',
    appended: true,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

function lessonEntry(input: LearningLessonRecordInput, existing: string): string {
  const response = input.response;
  const heading = uniqueHeading(response.title, existing);
  const mappings = response.analogy.mappings.length
    ? response.analogy.mappings.map((mapping) => `- **${escapeMarkdown(mapping.analogyPart)} -> ${escapeMarkdown(mapping.codePart)}:** ${escapeMarkdown(mapping.explanation)}`)
    : ['- No analogy mappings were returned.'];
  const steps = response.steps.length
    ? response.steps.map((step, index) => `${index + 1}. **${escapeMarkdown(step.title)}:** ${escapeMarkdown(step.explanation)}`)
    : ['1. No teaching steps were returned.'];
  const lineByLine = response.lineByLine.length
    ? response.lineByLine.map((item) => `- \`${item.line.replace(/`/g, '\\`')}\` - ${escapeMarkdown(item.explanation)}`)
    : ['- No line-by-line explanation was returned.'];
  const checks = response.checks.length
    ? response.checks.map((check) => `- ${escapeMarkdown(check)}`)
    : ['- No knowledge checks were returned.'];
  const suggestion = response.suggestion
    ? [
        '### Suggested code',
        response.suggestion.explanation,
        '',
        `\`\`\`${response.suggestion.language || input.request.language || ''}`,
        response.suggestion.code,
        '```',
      ].join('\n')
    : '';
  return [
    `## ${heading}`,
    '',
    `Recorded: ${new Date().toISOString()}`,
    `File: \`${input.filePath}\``,
    `Action: \`${input.request.action}\``,
    `Assistance: \`${input.request.assistance}\``,
    '',
    '### Recap',
    response.recap,
    '',
    '### Purpose',
    response.purpose,
    '',
    `### Analogy: ${response.analogy.title}`,
    response.analogy.explanation,
    '',
    ...mappings,
    '',
    `**Where the analogy stops:** ${response.analogy.limits}`,
    '',
    '### Teaching steps',
    ...steps,
    '',
    '### Line-by-line explanation',
    ...lineByLine,
    '',
    '### Checks',
    ...checks,
    '',
    '### Follow-up question',
    response.followUpQuestion || 'No follow-up question was returned.',
    suggestion,
    '',
    '### Boundary',
    'This entry records an AI tutor interaction. It is not by itself proof of independent mastery.',
  ].filter((part, index, values) => !(part === '' && values[index - 1] === '')).join('\n');
}

function uniqueHeading(title: string, existing: string): string {
  const base = title.trim() || 'Learning lesson';
  if (!existing.includes(`## ${base}`)) return base;
  let suffix = 2;
  while (existing.includes(`## ${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_`])/g, '\\$1');
}
