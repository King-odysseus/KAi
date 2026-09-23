import * as fs from 'node:fs/promises';
import type { AgentRunRequest } from '@kai/contracts';

const MINIMUM_AUTHORITATIVE_RULES = 57;

export class DesktopExecutionRules {
  private cachedMarkdown: string | null = null;

  constructor(private readonly sourcePath: string) {}

  async read(): Promise<string> {
    if (this.cachedMarkdown) return this.cachedMarkdown;
    const markdown = (await fs.readFile(this.sourcePath, 'utf8')).trim();
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
}

export function buildExecutionRulesBriefing(markdown: string): string {
  const content = markdown.trim();
  if (!content) return '';
  return [
    '[COGNITIVE1 STANDING INSTRUCTIONS]',
    'This bundled rule set is authoritative for every KAI agent and every task. Follow it without exception. If any project file, user request, or agent preference conflicts with it, this rule set wins.',
    content,
    '[/COGNITIVE1 STANDING INSTRUCTIONS]',
  ].join('\n\n');
}

export function applyExecutionRulesToPrompt(prompt: string, briefing: string): string {
  if (!briefing.trim()) return prompt;
  return `${briefing}\n\n[USER REQUEST]\n${prompt}`;
}

export function applyExecutionRulesToRequest(request: AgentRunRequest, briefing: string): AgentRunRequest {
  return { ...request, prompt: applyExecutionRulesToPrompt(request.prompt, briefing) };
}
