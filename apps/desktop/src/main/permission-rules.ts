import type { PermissionRule } from '@kai/contracts';
import { commandMatchesPrefix, globMatches } from './glob-match';
import type { ProjectToolPolicy } from './project-tools';

const COMMAND_TOOLS = new Set(['run_command', 'bash', 'shell_command']);
const EDIT_PATH_FIELDS = ['path', 'file_path', 'from', 'to', 'source', 'destination', 'cwd'];

export interface PermissionRuleCall {
  tool: string;
  input: unknown;
}

/**
 * Applies the project's user-written rules on top of the autonomy mode's own policy.
 *
 * A base `deny` is a hard floor: a rule can never open a tool the mode forbids. Otherwise `deny` beats `ask`, and
 * `ask` beats `allow`. A rule that matches nothing leaves the base decision untouched.
 */
export function applyPermissionRules(
  base: ProjectToolPolicy,
  rules: readonly PermissionRule[] | undefined,
  call: PermissionRuleCall,
): ProjectToolPolicy {
  if (!rules?.length || base.decision === 'deny') return base;
  const matching = rules.filter((rule) => ruleMatches(rule, call));
  if (matching.length === 0) return base;

  const deny = matching.find((rule) => rule.effect === 'deny');
  if (deny) return { decision: 'deny', reason: deny.note || `A project rule blocks ${call.tool}.` };

  const ask = matching.find((rule) => rule.effect === 'ask');
  if (ask) {
    return {
      decision: 'ask',
      title: `Allow ${call.tool}?`,
      detail: ask.note || 'A project rule asks for a decision before this action.',
      risk: 'medium',
    };
  }

  // The only remaining effect is allow, which relaxes an ask but keeps a base allow as it is.
  return base.decision === 'ask' ? { decision: 'allow' } : base;
}

export function ruleMatches(rule: PermissionRule, call: PermissionRuleCall): boolean {
  const input = asRecord(call.input);
  if (rule.tools.length > 0 && !rule.tools.some((pattern) => globMatches(pattern, call.tool))) return false;

  if (rule.commands.length > 0) {
    if (!COMMAND_TOOLS.has(call.tool)) return false;
    const command = input && typeof input.command === 'string' ? input.command : '';
    if (!command || !rule.commands.some((prefix) => commandMatchesPrefix(command, prefix))) return false;
  }

  if (rule.paths.length > 0) {
    const paths = EDIT_PATH_FIELDS.flatMap((field) => (input && typeof input[field] === 'string' ? [input[field] as string] : []));
    if (paths.length === 0 || !paths.some((path) => rule.paths.some((pattern) => globMatches(pattern, path)))) return false;
  }

  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
