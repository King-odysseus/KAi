import * as fs from 'fs/promises';

export interface KaiRule {
  id: string;
  number: number;
  section: string;
  title: string;
  body: string;
}

export interface KaiRuleInput {
  id: string;
  title: string;
  body: string;
}

export interface KaiRuleDocument {
  path: string;
  markdown: string;
  rules: KaiRule[];
  sessionWorkflow: string;
}

/**
 * Reads and edits the authoritative Cognitive1 Instruct.md file directly.
 * Keeping the markdown file as the store prevents KAI's UI from drifting
 * away from the rule set already used by the rest of the Cognitive1 system.
 */
export class CognitiveRuleStore {
  constructor(private readonly sourcePath: string) {}

  async read(): Promise<KaiRuleDocument> {
    const markdown = await fs.readFile(this.sourcePath, 'utf8');
    return {
      path: this.sourcePath,
      markdown,
      rules: parseRules(markdown),
      sessionWorkflow: parseSessionWorkflow(markdown),
    };
  }

  async save(input: KaiRuleInput): Promise<KaiRuleDocument> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('Rule title is required.');
    if (!body) throw new Error('Rule text is required.');

    const document = await this.read();
    const existing = document.rules.find((rule) => rule.id === input.id);
    const nextMarkdown = existing
      ? replaceRule(document.markdown, existing, { ...input, title, body })
      : appendRule(document.markdown, title, body);
    await fs.writeFile(this.sourcePath, nextMarkdown, 'utf8');
    return this.read();
  }
}

export function buildExecutionRulesBriefing(markdown: string): string {
  const content = markdown.trim();
  if (!content) return '';
  return [
    '[COGNITIVE1 STANDING INSTRUCTIONS]',
    'This is the authoritative Cognitive1 rule set. Follow it for every task and every agent. If anything conflicts with it, this file wins.',
    content,
    '[/COGNITIVE1 STANDING INSTRUCTIONS]',
  ].join('\n\n');
}

function parseRules(markdown: string): KaiRule[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Rules\s*$/.test(line));
  if (start < 0) return [];
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const rules: KaiRule[] = [];
  let section = '';
  let current: { number: number; title: string; bodyLines: string[] } | undefined;

  const flush = () => {
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

function replaceRule(markdown: string, rule: KaiRule, input: KaiRuleInput): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const rulesStart = lines.findIndex((line) => /^##\s+Rules\s*$/.test(line));
  if (rulesStart < 0) throw new Error('The Rules section was not found in Instruct.md.');
  const nextSectionOffset = lines.slice(rulesStart + 1).findIndex((line) => /^##\s+/.test(line));
  const rulesEnd = nextSectionOffset < 0 ? lines.length : rulesStart + 1 + nextSectionOffset;
  const start = lines.findIndex((line, index) => index > rulesStart && index < rulesEnd && new RegExp(`^${rule.number}\\.\\s+`).test(line));
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
  const replacement = formatRule(rule.number, input.title, input.body);
  lines.splice(start, end - start, ...replacement.split('\n'));
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
  const customStart = lines.findIndex((line, index) => index > rulesStart && index < rulesEnd && /^###\s+Custom\s*$/.test(line));

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
