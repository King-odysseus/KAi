import { z } from 'zod';

/**
 * A user-owned rule that adjusts what an agent may do in a project. Rules live with the project's preferences,
 * never in the repository, so a cloned project cannot grant itself access.
 *
 * A rule must name at least one matcher. `tools` matches tool names (a glob such as `mcp_*`), `commands` matches
 * the beginning of a `run_command` command, and `paths` matches project-relative paths (a glob such as `src/**`).
 * When a rule names several matcher groups, all of them must match.
 */
export const permissionRuleSchema = z
  .object({
    id: z.string().min(1).max(100),
    effect: z.enum(['allow', 'ask', 'deny']),
    tools: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    commands: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    paths: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine(
    (rule) => rule.tools.length > 0 || rule.commands.length > 0 || rule.paths.length > 0,
    'A permission rule needs at least one tool, command or path matcher.',
  );
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionRulesSchema = z.array(permissionRuleSchema).max(100);
