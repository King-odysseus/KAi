import { agentIdSchema, executionModeSchema, routeModeSchema, type AgentId, type ConversationRecord, type ExecutionMode, type RouteMode } from '@kai/contracts';

const AGENT_KEY = 'kai.lastAgent';
const ROUTE_KEY = 'kai.lastRoute';
const EXECUTION_KEY = 'kai.lastExecution';

export interface AgentChoice {
  agent: AgentId;
  route: RouteMode;
  execution: ExecutionMode;
}

/** The composer agent, execution mode, and route picked last, or null when nothing valid was saved. */
export function rememberedAgentChoice(storage: Pick<Storage, 'getItem'> | null = safeStorage()): AgentChoice | null {
  try {
    const agent = agentIdSchema.safeParse(storage?.getItem(AGENT_KEY));
    if (!agent.success) return null;
    const route = routeModeSchema.safeParse(storage?.getItem(ROUTE_KEY));
    const execution = executionModeSchema.safeParse(storage?.getItem(EXECUTION_KEY));
    return { agent: agent.data, route: route.success ? route.data : 'direct', execution: execution.success ? execution.data : 'cli' };
  } catch {
    return null;
  }
}

export function rememberAgentChoice(choice: AgentChoice, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(AGENT_KEY, choice.agent);
    storage?.setItem(ROUTE_KEY, choice.route);
    storage?.setItem(EXECUTION_KEY, choice.execution);
  } catch {
    // Remembering the last agent is a convenience only.
  }
}

/**
 * The agent to show when KAI opens: the user's last composer choice first, then the reopened
 * conversation's historical choice, then the Settings default.
 */
export function startupAgentChoice(
  conversation: Pick<ConversationRecord, 'activeAgent' | 'route' | 'execution'> | null | undefined,
  remembered: AgentChoice | null,
  defaults: AgentChoice,
): AgentChoice {
  // The choice in the composer is intentional. Restore it before falling back to a
  // reopened conversation, whose historical route may be different.
  if (remembered) return remembered;
  if (conversation?.activeAgent) return { agent: conversation.activeAgent, route: conversation.route ?? defaults.route, execution: conversation.execution ?? defaults.execution };
  return defaults;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
