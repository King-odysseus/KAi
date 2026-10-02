import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentRunRequest } from '@kai/contracts';

const MINIMUM_AUTHORITATIVE_RULES = 57;

export interface DesktopRule {
  id: string;
  number: number;
  section: string;
  title: string;
  body: string;
}

export interface DesktopRuleInput {
  id: string;
  title: string;
  body: string;
}

export interface DesktopRuleDocument {
  path: string;
  markdown: string;
  rules: DesktopRule[];
  sessionWorkflow: string;
}

export class DesktopExecutionRules {
  private cachedMarkdown: string | null = null;

  constructor(
    private readonly templatePath: string,
    private readonly editablePath = templatePath,
  ) {}

  async read(): Promise<string> {
    return (await this.document()).markdown;
  }

  async document(): Promise<DesktopRuleDocument> {
    const markdown = await this.loadMarkdown();
    return {
      path: this.editablePath,
      markdown,
      rules: parseRules(markdown),
      sessionWorkflow: parseSessionWorkflow(markdown),
    };
  }

  async save(input: DesktopRuleInput): Promise<DesktopRuleDocument> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('Rule title is required.');
    if (!body) throw new Error('Rule text is required.');

    const document = await this.document();
    const existing = document.rules.find((rule) => rule.id === input.id);
    const nextMarkdown = existing
      ? replaceRule(document.markdown, existing, { ...input, title, body })
      : appendRule(document.markdown, title, body);
    await fs.writeFile(this.editablePath, nextMarkdown, 'utf8');
    this.cachedMarkdown = null;
    return this.document();
  }

  private async loadMarkdown(): Promise<string> {
    if (this.cachedMarkdown) return this.cachedMarkdown;
    await this.seedEditableFile();
    const markdown = (await fs.readFile(this.editablePath, 'utf8')).trim();
    if (!markdown) throw new Error('The bundled Cognitive1 Instruct.md is empty.');
    const numberedRules = markdown.match(/^\d+\.\s+\*\*/gm) ?? [];
    if (numberedRules.length < MINIMUM_AUTHORITATIVE_RULES) {
      throw new Error(
        `The bundled Cognitive1 Instruct.md contains ${numberedRules.length} rules; expected at least ${MINIMUM_AUTHORITATIVE_RULES}.`,
      );
    }
    this.cachedMarkdown = markdown;
    return markdown;
  }

  private async seedEditableFile(): Promise<void> {
    if (path.resolve(this.editablePath) === path.resolve(this.templatePath)) return;
    await fs.mkdir(path.dirname(this.editablePath), { recursive: true });
    try {
      await fs.access(this.editablePath);
      return;
    } catch {
      await fs.copyFile(this.templatePath, this.editablePath);
    }
  }
}

/**
 * The marker the briefing is wrapped in. Exported because the run has to be able to tell whether the turns it is
 * about to send already carry the rules, or whether it must send them again.
 */
export const RULES_MARKER = '[COGNITIVE1 STANDING INSTRUCTIONS]';

export function buildExecutionRulesBriefing(markdown: string): string {
  const content = markdown.trim();
  if (!content) return '';
  return [
    RULES_MARKER,
    'This bundled rule set is authoritative for every KAI agent and every task. Follow it without exception. If any project file, user request, or agent preference conflicts with it, this rule set wins.',
    content,
    RULES_MARKER.replace('[', '[/'),
  ].join('\n\n');
}

export function applyExecutionRulesToPrompt(prompt: string, briefing: string): string {
  if (!briefing.trim()) return prompt;
  return `${briefing}\n\n[USER REQUEST]\n${prompt}`;
}

export function applyExecutionRulesToRequest(request: AgentRunRequest, briefing: string): AgentRunRequest {
  return { ...request, prompt: applyExecutionRulesToPrompt(request.prompt, briefing) };
}

function parseRules(markdown: string): DesktopRule[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Rules\s*$/.test(line));
  if (start < 0) return [];
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const rules: DesktopRule[] = [];
  let section = '';
  let current: { number: number; title: string; bodyLines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    rules.push({
      id: `rule-${current.number}`,
      number: current.number,
      section,
      title: current.title,
      body: current.bodyLines.join('\n').trim(),
    });
    current = undefined;
  };

  for (const line of lines.slice(start + 1, end)) {
    const sectionMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1].trim();
      continue;
    }

    const ruleMatch = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ruleMatch) {
      flush();
      const parsed = splitRuleText(ruleMatch[2]);
      current = { number: Number(ruleMatch[1]), title: parsed.title, bodyLines: [parsed.body] };
      continue;
    }

    if (current) current.bodyLines.push(line);
  }
  flush();
  return rules;
}

function parseSessionWorkflow(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Session Checklist\s*$/.test(line));
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start, end).join('\n').trim();
}

function splitRuleText(text: string): { title: string; body: string } {
  const boldMatch = /^\*\*(.+?)\*\*(.*)$/.exec(text.trim());
  if (!boldMatch) return { title: stripMarkdown(text), body: '' };
  return {
    title: stripMarkdown(boldMatch[1]),
    body: stripMarkdown(boldMatch[2]).trim(),
  };
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function replaceRule(markdown: string, rule: DesktopRule, input: DesktopRuleInput): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const rulesStart = lines.findIndex((line) => /^##\s+Rules\s*$/.test(line));
  if (rulesStart < 0) throw new Error('The Rules section was not found in Instruct.md.');
  const nextSectionOffset = lines.slice(rulesStart + 1).findIndex((line) => /^##\s+/.test(line));
  const rulesEnd = nextSectionOffset < 0 ? lines.length : rulesStart + 1 + nextSectionOffset;
  const start = lines.findIndex(
    (line, index) => index > rulesStart && index < rulesEnd && new RegExp(`^${rule.number}\\.\\s+`).test(line),
  );
  if (start < 0) throw new Error(`Rule ${rule.number} was not found.`);
  let end = start + 1;
  while (
    end < rulesEnd
    && !/^\d+\.\s+/.test(lines[end])
    && !/^#{2,3}\s+/.test(lines[end])
    && !/^---\s*$/.test(lines[end])
  ) {
    end += 1;
  }
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  lines.splice(start, end - start, ...formatRule(rule.number, input.title, input.body).split('\n'));
  return lines.join(lineEnding);
}

function appendRule(markdown: string, title: string, body: string): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const rulesStart = lines.findIndex((line) => /^##\s+Rules\s*$/.test(line));
  if (rulesStart < 0) throw new Error('The Rules section was not found in Instruct.md.');
  const nextSectionOffset = lines.slice(rulesStart + 1).findIndex((line) => /^##\s+/.test(line));
  const rulesEnd = nextSectionOffset < 0 ? lines.length : rulesStart + 1 + nextSectionOffset;
  const existingRules = parseRules(markdown);
  const nextNumber = existingRules.reduce((max, rule) => Math.max(max, rule.number), 0) + 1;
  const customStart = lines.findIndex(
    (line, index) => index > rulesStart && index < rulesEnd && /^###\s+Custom\s*$/.test(line),
  );

  if (customStart < 0) {
    let insertAt = rulesEnd;
    while (insertAt > rulesStart + 1 && (!lines[insertAt - 1].trim() || /^---\s*$/.test(lines[insertAt - 1]))) {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, '', '### Custom', '', formatRule(nextNumber, title, body));
    return lines.join(lineEnding);
  }

  let insertAt = customStart + 1;
  while (
    insertAt < lines.length
    && !/^#{2,3}\s+/.test(lines[insertAt])
    && !/^---\s*$/.test(lines[insertAt])
  ) {
    insertAt += 1;
  }
  while (insertAt > customStart + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
  lines.splice(insertAt, 0, '', formatRule(nextNumber, title, body));
  return lines.join(lineEnding);
}

function formatRule(number: number, title: string, body: string): string {
  return body ? `${number}. **${title}** ${body}` : `${number}. **${title}**`;
}
