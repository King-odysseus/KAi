import type { PermissionRule } from '@kai/contracts';
import { isPublishingCommand } from './project-tools';
import { ruleMatches } from './permission-rules';

/**
 * Turns the questions KAI has already put to the user into rules they can accept in one click. A command or tool
 * the user has approved again and again is a candidate for an `allow` rule; nothing is ever applied without them
 * adding it, and nothing dangerous is ever offered.
 */
export interface ApprovalLike {
  type: string;
  tool?: string;
  detail?: string;
}

export interface PermissionSuggestion {
  rule: PermissionRule;
  /** How many times the user was asked about this. */
  count: number;
  /** One line saying what the rule would stop asking about. */
  summary: string;
}

/** A tool the user must always decide on, however often it comes up. */
const NEVER_SUGGEST_TOOLS = new Set(['delete_file', 'ask_user', 'run_command']);
/** Commands that destroy data or run downloaded code: never offered as a standing allow. */
const RISKY_COMMAND = /(?:^|[\s;&|])(?:rm|rmdir|del|erase|rd|format|mkfs|dd|sudo|su|chmod|chown|kill|taskkill|shutdown|reboot|curl|wget|iex|invoke-expression|invoke-webrequest|powershell|pwsh|cmd|bash|sh|eval|npx|git\s+(?:reset|clean|checkout|rebase|push))\b/i;
/** Tools whose first argument is a sub-command, so the useful prefix is two words (`npm test`, not `npm`). */
const SUBCOMMAND_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'git', 'cargo', 'go', 'dotnet', 'gradle', 'mvn', 'pip', 'python', 'node', 'docker', 'make']);
const MIN_ASKS = 3;
const MAX_SUGGESTIONS = 8;

/** The arguments the approval detail ends with: the model's own JSON, after a blank line. */
function argumentsOf(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const start = detail.indexOf('\n\n{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(detail.slice(start + 2));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // A long argument list is cut off mid-JSON; it simply gives no suggestion.
  }
}

/** `npm test --silent` -> `npm test`; `ls -la` -> `ls`. Undefined when the command is chained or risky. */
export function commandPrefix(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[;&|<>`$(){}\n]/.test(trimmed) || RISKY_COMMAND.test(trimmed) || isPublishingCommand(trimmed)) return undefined;
  const words = trimmed.split(/\s+/);
  const head = words[0].toLowerCase();
  if (SUBCOMMAND_TOOLS.has(head) && words[1] && !words[1].startsWith('-')) {
    // `npm run build` is a script name, so keep three words for `run`.
    return head === 'npm' || head === 'pnpm' || head === 'yarn' ? (words[1] === 'run' && words[2] ? words.slice(0, 3).join(' ') : words.slice(0, 2).join(' ')) : words.slice(0, 2).join(' ');
  }
  return words[0];
}

export function suggestPermissionRules(events: readonly ApprovalLike[], existing: readonly PermissionRule[]): PermissionSuggestion[] {
  const counts = new Map<string, { rule: PermissionRule; count: number; summary: string; sample: { tool: string; input: unknown } }>();
  for (const event of events) {
    if (event.type !== 'approval.request' || !event.tool) continue;
    let key: string;
    let rule: PermissionRule;
    let summary: string;
    let sample: { tool: string; input: unknown };
    if (event.tool === 'run_command') {
      const command = argumentsOf(event.detail)?.command;
      const prefix = typeof command === 'string' ? commandPrefix(command) : undefined;
      if (!prefix) continue;
      key = `cmd:${prefix}`;
      rule = { id: `suggested-cmd-${prefix.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, effect: 'allow', tools: ['run_command'], commands: [prefix], paths: [], note: `Allowed after you approved "${prefix}" repeatedly.` };
      summary = `Stop asking before running "${prefix} ..."`;
      sample = { tool: 'run_command', input: { command: prefix } };
    } else if (!NEVER_SUGGEST_TOOLS.has(event.tool) && event.tool.startsWith('mcp_')) {
      key = `tool:${event.tool}`;
      rule = { id: `suggested-tool-${event.tool.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`, effect: 'allow', tools: [event.tool], commands: [], paths: [], note: `Allowed after you approved ${event.tool} repeatedly.` };
      summary = `Stop asking before using ${event.tool}`;
      sample = { tool: event.tool, input: {} };
    } else {
      continue;
    }
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { rule, count: 1, summary, sample });
  }
  return [...counts.values()]
    .filter((entry) => entry.count >= MIN_ASKS)
    // Already decided: any existing rule (of any effect) that would match this call means the user has a say here.
    .filter((entry) => !existing.some((rule) => rule.id === entry.rule.id || ruleMatches(rule, entry.sample)))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ rule, count, summary }) => ({ rule, count, summary }));
}
