import { z } from 'zod';
import { projectAutomationSchema } from './automation';
import { mcpServerSettingsSchema } from './domain';
import { agentTeamSchema } from './team';

const portableSegment = (value: string): boolean => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
const safeSkillRelativePath = (value: string): boolean => value.split('/').every((segment) => segment.length > 0
  && segment !== '.' && segment !== '..' && !segment.startsWith('.')
  && !/[<>:"|?*\\\u0000-\u001f]/.test(segment)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));

export const capabilityBundleSkillSchema = z.object({
  name: z.string().refine((value) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) && portableSegment(value), 'Use a portable skill name.'),
  files: z.array(z.object({
    path: z.string().min(1).max(240).refine(safeSkillRelativePath, 'Use a safe relative skill file path.'),
    content: z.string().max(256_000),
  }).strict()).min(1).max(100),
}).strict().superRefine((skill, context) => {
  if (!skill.files.some((file) => file.path === 'SKILL.md')) context.addIssue({ code: 'custom', message: 'Every bundled skill must contain SKILL.md.', path: ['files'] });
  if (new Set(skill.files.map((file) => file.path.toLowerCase())).size !== skill.files.length) context.addIssue({ code: 'custom', message: 'Skill file paths must be unique.', path: ['files'] });
});

/** A portable, reviewed set of agent capabilities. Credential values are deliberately not part of MCP settings. */
export const capabilityBundleSchema = z.object({
  format: z.literal('kai-capability-bundle'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  skills: z.array(capabilityBundleSkillSchema).max(100).default([]),
  team: agentTeamSchema.optional(),
  projectAutomation: projectAutomationSchema.optional(),
  mcpServers: z.array(mcpServerSettingsSchema).max(100).default([]),
}).strict().superRefine((bundle, context) => {
  const names = bundle.skills.map((skill) => skill.name.toLowerCase());
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'Skill names must be unique.', path: ['skills'] });
  if (bundle.skills.reduce((total, skill) => total + skill.files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0), 0) > 2_000_000) {
    context.addIssue({ code: 'custom', message: 'The skill files exceed the 2 MB bundle limit.', path: ['skills'] });
  }
  const serverIds = bundle.mcpServers.map((server) => server.id.toLowerCase());
  if (new Set(serverIds).size !== serverIds.length) context.addIssue({ code: 'custom', message: 'MCP server IDs must be unique.', path: ['mcpServers'] });
});
export type CapabilityBundle = z.infer<typeof capabilityBundleSchema>;

export const capabilityBundleSkillsInputSchema = z.object({
  projectId: z.string().min(1),
  names: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)).max(100),
}).strict();
