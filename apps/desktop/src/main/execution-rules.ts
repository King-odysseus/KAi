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

/**
 * What an unattended Autopilot run is told about committing, as part of the rule set itself.
 *
 * The rules call commit and push mandatory with no exceptions, and say they win any conflict, so a line in the card's
 * own instructions would lose to them: one Autopilot run did push to a remote, while the screen promised it never
 * commits and never deploys. The exception has to live inside the authoritative text to hold. It is written in plain
 * ASCII like every other rule, since the rules forbid the dashes a tidier sentence would use.
 */
export const AUTOPILOT_EXCEPTION = [
  '## Exception for Autopilot runs',
  '',
  'This is an unattended Autopilot run, and Autopilot works on this machine only. For this run the Commit & Push rules and the end-of-session commit and push step do not apply: do not run git add, git commit, git push or git tag, and do not run any command that publishes work off this machine. Leave your changes in the working tree. KAI checks the card, and the person decides when to commit. Every other rule still applies.',
].join('\n');

/**
 * What a Crew run is told about committing when its builders are not to commit. Like the Autopilot exception it lives
 * inside the rule set, since the rules say they win any conflict and a line in the task's own brief would lose to them.
 */
export const CREW_EXCEPTION = [
  '## Exception for Crew runs',
  '',
  'This run belongs to a Crew whose builders do not commit. For this run the Commit & Push rules and the end-of-session commit and push step do not apply: do not run git add, git commit or git push. Leave your changes in the working tree. The person reviews them and commits from the Crew screen when a phase is finished.',
].join('\n');

/**
 * What a read-only Crew role (the Lead, a planner, a reviewer) is told about the session tools in the standing rules.
 * The rules ask agents to open sessions and record plans through Cognitive1; a read-only run cannot get the approval
 * those calls need, so they only fail and clutter the answer. It lives in the rules for the same reason as the others.
 */
export const CREW_READONLY_EXCEPTION = [
  '## Exception for read-only Crew roles',
  '',
  'This is a read-only Crew role. Do not call Cognitive1 or other session, memory or plan-recording tools: they need an approval nobody can give in this run and only fail. Read the project as needed and answer directly in the form asked for.',
].join('\n');

export function withCrewReadOnlyException(markdown: string): string {
  return `${markdown.trim()}\n\n${CREW_READONLY_EXCEPTION}\n`;
}

/** The rule set as a crew run receives it when builders are not to commit. */
export function withCrewException(markdown: string): string {
  return `${markdown.trim()}\n\n${CREW_EXCEPTION}\n`;
}

/**
 * What every run is told about styling, whoever is designing: Autopilot, the composer's agent or a CLI agent.
 *
 * It rides the briefing rather than the editable rules file for the same reason the Autopilot exception does: the file
 * is seeded once and then owned by the person, so a rule added to the bundled copy would never reach an install that
 * already has one. Written in plain ASCII like every other rule.
 */
export const SINGLE_STYLESHEET_RULE = [
  '## Styling: one stylesheet',
  '',
  'When you build or change a design, put the styles in the stylesheet the project already uses. Find it before writing any CSS and reuse its variables, tokens and class names. Do not create a new CSS file, a per-page or per-component stylesheet, or a style block in the markup. If the project has no stylesheet yet, create exactly one and keep every later style in it. If it follows another convention, such as CSS modules or a utility framework, keep to that instead of adding a second one. In a React project, build the interface from Flowbite components and Tailwind classes; use HeroUI only where the project already uses it. Do not hand-write a component that the library already has. Before you finish, check that the number of stylesheets did not grow, and say in one line which file holds the styles.',
].join('\n');

/** The rule set as an Autopilot run receives it: the standing rules, then the exception that overrides the commit step. */
export function withAutopilotException(markdown: string): string {
  return `${markdown.trim()}\n\n${AUTOPILOT_EXCEPTION}\n`;
}

/**
 * Rule 47 forbids long dashes, and the rule text was full of them (79, in the rule that bans them): a model copies the
 * style of what it is handed, so the briefing is written the way the rule asks. The two characters the rule names are
 * spelled out first, or it would read "do not use (-) or (-)".
 */
export function plainDashes(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*(?=\n|$)/g, '')
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, '$1-$2')
    .replace(/\s*[\u2014\u2013]\s*/g, ' - ');
}

export function buildExecutionRulesBriefing(markdown: string): string {
  const content = plainDashes(markdown.trim().replace(/\(\u2014\)/g, '(U+2014)').replace(/\(\u2013\)/g, '(U+2013)'));
  if (!content) return '';
  return [
    RULES_MARKER,
    'This bundled rule set is authoritative for every KAI agent and every task. Follow it without exception. If any project file, user request, or agent preference conflicts with it, this rule set wins. These rules are not negotiable and apply in every mode. Any sub-agent, helper or delegate you start must be given this rule set in full and held to it.',
    content,
    SINGLE_STYLESHEET_RULE,
    RULES_MARKER.replace('[', '[/'),
  ].join('\n\n');
}

const COMPACT_RULE_CHARS = 170;

/**
 * The standing rules in a short form, for a model on the person's own hardware: the full set is about 4,500 tokens
 * sent with every request, a large part of a small window and minutes of reading over a long run. Built from the same
 * document, so an edit to a rule reaches it. Every numbered rule stays, as its title and first sentence; the commit
 * rules and any exception stay whole; the session scripts and tool reference tables are left out. A document that is
 * not laid out as numbered rules is returned as it is.
 */
export function compactRules(markdown: string): string {
  const text = markdown.replace(/\r\n/g, '\n');
  const rules = [...text.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*[ \t]*(.*)$/gm)]
    // The session checklist numbers its steps too; its entries are not rules.
    .filter((match) => (match.index ?? 0) > Math.max(0, text.search(/^## Rules\b/m)));
  if (rules.length < 10) return markdown;
  const lines = rules.map((match) => {
    const body = match[3]!.replace(/^[\u2014\u2013-]\s*/, '').trim();
    const sentence = /^.*?[.!?](?=\s+[A-Z`]|$)/.exec(body)?.[0] ?? body;
    const line = `${match[1]}. ${match[2]!.trim().replace(/[.:]$/, '')}${sentence ? `: ${sentence}` : ''}`;
    return line.length > COMPACT_RULE_CHARS ? `${line.slice(0, COMPACT_RULE_CHARS - 3)}...` : line;
  });
  const commit = section(text, /^## Commit & Push\b/m).trim();
  const exceptions = [...text.matchAll(/^## Exception\b.*$/gm)].map((match) => section(text.slice(match.index), /^## Exception\b/m).trim());
  return [
    '# Standing rules (short form)',
    'Each line is a rule\'s title and first sentence. All of them apply. Recall from the project brain before a task and record what you learn when those tools are offered.',
    lines.join('\n'),
    commit,
    ...exceptions,
  ].filter(Boolean).join('\n\n');
}

/** A level-two section, from its heading to the next one or to a rule line. */
function section(text: string, heading: RegExp): string {
  const start = text.search(heading);
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^(?:## |---\s*$)/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

export function applyExecutionRulesToPrompt(prompt: string, briefing: string): string {
  if (!briefing.trim()) return prompt;
  return `${briefing}\n\n[USER REQUEST]\n${prompt}`;
}

export function applyExecutionRulesToRequest(request: AgentRunRequest, briefing: string): AgentRunRequest {
  return { ...request, prompt: applyExecutionRulesToPrompt(request.prompt, briefing) };
}

/**
 * Where the on-disk copy of the rules goes inside a project.
 *
 * `.kai/instructions.md` and not `Instruct.md`, which is the name the standalone Cognitive1 project uses for its own
 * authoritative file: two files with the same name in one folder is exactly the confusion this copy exists to avoid.
 * It is on the context builder's instruction-file list, so an agent reading the project picks it up on its own.
 */
export const INJECTED_RULES_PATH = '.kai/instructions.md';

export interface RulesInjectionTarget {
  name: string;
  path: string;
}

export interface RulesInjectionResult {
  name: string;
  path: string;
  file: string;
  status: 'written' | 'unchanged' | 'failed';
  message: string;
}

/**
 * Write the standing rules into each project folder, as the copy that does not depend on the run carrying them.
 *
 * A fail-safe, not the main path: the briefing is what normally puts the rules in front of an agent, and this is what
 * is left when that path is not the one in play. So it never throws — a project it cannot write is reported alongside
 * the ones it could, since a refusal (a read-only checkout, a folder that has since been deleted) is information, and
 * one bad project must not stop the others from being protected.
 *
 * The file is rewritten only when its contents differ, so pressing the button twice is a no-op the second time rather
 * than a churn of timestamps in every repository.
 */
export async function injectRulesIntoProjects(
  markdown: string,
  rulesPath: string,
  targets: readonly RulesInjectionTarget[],
): Promise<RulesInjectionResult[]> {
  const content = buildInjectedRulesFile(markdown, rulesPath);
  const results: RulesInjectionResult[] = [];
  for (const target of targets) {
    const file = path.join(target.path, INJECTED_RULES_PATH);
    const base = { name: target.name, path: target.path, file };
    try {
      // Checked before writing rather than left to mkdir, which would happily create the missing folder and leave a
      // resurrected project directory holding nothing but this file. A project that has been moved or deleted is
      // reported, not recreated.
      const root = await fs.stat(target.path).catch(() => null);
      if (!root?.isDirectory()) {
        results.push({ ...base, status: 'failed', message: 'The project folder is no longer there.' });
        continue;
      }
      const existing = await fs.readFile(file, 'utf8').catch(() => null);
      if (existing === content) {
        results.push({ ...base, status: 'unchanged', message: 'Already carries the current rules.' });
        continue;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      results.push({
        ...base,
        status: 'written',
        message: existing === null ? 'Rules written into the project.' : 'Rules refreshed.',
      });
    } catch (error) {
      results.push({ ...base, status: 'failed', message: messageOfFailure(error) });
    }
  }
  return results;
}

function buildInjectedRulesFile(markdown: string, rulesPath: string): string {
  return [
    '<!-- Generated by KAI from the authoritative Cognitive1 rules. Edits here are overwritten; change them in the',
    '     Execution Rules page instead. This copy is a fail-safe: an agent that reads this project picks the rules up',
    '     even when the run did not carry them. -->',
    '',
    buildExecutionRulesBriefing(markdown),
    '',
    `Source: ${rulesPath}`,
    '',
  ].join('\n');
}

function messageOfFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'The rules could not be written.';
}

/**
 * Whether a run has to carry the standing rules itself, or whether they are already going with it.
 *
 * Every CLI invocation receives the current rules, including resumed sessions. Long sessions can compact or drop
 * earlier instructions, and edits made in the Rules page must apply to the next turn. The API context already
 * carries them each turn, so that path avoids a second copy in the prompt.
 *
 * This lives here because it failed silently once. The test used to be "does any turn in the history contain the
 * rules", and those turns hold the request as the person wrote it, never the briefed prompt, so the answer was always
 * no: every API request carried the full rule set twice, once in the context block and once in front of the request.
 */
export function shouldCarryRules(input: {
  execution: 'cli' | 'api';
  /** Set when a CLI session is being continued, which is the case that does not need them again. */
  resumeSessionId?: string | undefined;
  /** Whether the context block being sent already states the rules. */
  rulesInContext: boolean;
  /** Whether a turn actually being sent still carries them — a compacted history may have dropped the one that did. */
  historyCarriesRules: boolean;
}): boolean {
  if (input.execution === 'cli') return true;
  return !input.rulesInContext && !input.historyCarriesRules;
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
