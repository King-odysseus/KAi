import { z } from 'zod';
import { conversationRecordV1Schema } from './domain';
import { contextChipSchema } from './context';
import { persistedEventV1Schema } from './events';
import { agentIdSchema, autonomyModeSchema, executionModeSchema, providerIdSchema, routeModeSchema } from './primitives';
import { goalInputSchema } from './workbench';

export const agentCapabilitySchema = z
  .object({
    id: agentIdSchema,
    displayName: z.string().min(1),
    available: z.boolean(),
    state: z.enum(['ready', 'signed_out', 'not_installed', 'unavailable']),
    version: z.string().optional(),
    unavailableReason: z.string().optional(),
    command: z.string().min(1),
    signInCommand: z.string().min(1),
    installUrl: z.string().url(),
    supportsRoutes: z.array(routeModeSchema),
    supportsAutonomy: z.array(autonomyModeSchema),
  })
  .strict();

export const agentRunRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    prompt: z.string().trim().min(1).max(20_000),
    agent: agentIdSchema,
    execution: executionModeSchema.optional(),
    route: routeModeSchema,
    autonomy: autonomyModeSchema,
    goal: goalInputSchema.optional(),
    skills: z.array(z.string().min(1).max(200)).max(50).optional(),
    selectedPaths: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    contextChips: z.array(contextChipSchema).max(50).optional(),
  })
  .strict();

export const agentRunResultSchema = z
  .object({
    conversation: conversationRecordV1Schema,
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    error: z.string().optional(),
  })
  .strict();

export const agentCancelInputSchema = z
  .object({
    conversationId: z.string().min(1),
  })
  .strict();

export const agentSignInInputSchema = z
  .object({
    agent: agentIdSchema,
  })
  .strict();

export const agentSignInResultSchema = z
  .object({
    agent: agentIdSchema,
    started: z.boolean(),
    command: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const agentApprovalResponseInputSchema = z
  .object({
    conversationId: z.string().min(1),
    requestId: z.string().min(1),
    approved: z.boolean(),
  })
  .strict();

export const directApiCapabilitySchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    provider: providerIdSchema,
    displayName: z.string().min(1),
    model: z.string(),
    baseUrl: z.string().url(),
    credentialId: z.string().min(1),
    credentialStored: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsTools: z.boolean(),
    unavailableReason: z.string().optional(),
  })
  .strict();

export const agentRunEventSchema = z
  .object({
    conversationId: z.string().min(1),
    event: persistedEventV1Schema,
  })
  .strict();

export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;
export type AgentCancelInput = z.infer<typeof agentCancelInputSchema>;
export type AgentSignInInput = z.infer<typeof agentSignInInputSchema>;
export type AgentSignInResult = z.infer<typeof agentSignInResultSchema>;
export type AgentApprovalResponseInput = z.infer<typeof agentApprovalResponseInputSchema>;
export type DirectApiCapability = z.infer<typeof directApiCapabilitySchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
