import { agentIdSchema, routeModeSchema, type AgentId, type ConversationRecord, type RouteMode } from '@kai/contracts';

const AGENT_KEY = 'kai.lastAgent';
const ROUTE_KEY = 'kai.lastRoute';

export interface AgentChoice {
  agent: AgentId;
  route: RouteMode;
}

/** The CLI agent and route picked last, or null when nothing valid was saved. */
export function rememberedAgentChoice(storage: Pick<Storage, 'getItem'> | null = safeStorage()): AgentChoice | null {
  try {
    const agent = agentIdSchema.safeParse(storage?.getItem(AGENT_KEY));
    if (!agent.success) return null;
    const route = routeModeSchema.safeParse(storage?.getItem(ROUTE_KEY));
    return { agent: agent.data, route: route.success ? route.data : 'direct' };
  } catch {
    return null;
  }
}

export function rememberAgentChoice(choice: AgentChoice, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(AGENT_KEY, choice.agent);
    storage?.setItem(ROUTE_KEY, choice.route);
  } catch {
    // Remembering the last agent is a convenience only.
  }
}

/**
 * The agent to show when KAI opens: the reopened conversation's own agent first, then the agent picked
 * last time, then the Settings default.
 */
export function startupAgentChoice(
  conversation: Pick<ConversationRecord, 'activeAgent' | 'route'> | null | undefined,
  remembered: AgentChoice | null,
  defaults: AgentChoice,
): AgentChoice {
  if (conversation?.activeAgent) {
    return { agent: conversation.activeAgent, route: conversation.route ?? remembered?.route ?? defaults.route };
  }
  return remembered ?? defaults;
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
