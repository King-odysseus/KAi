import type { AgentRunRequest } from '@kai/contracts';

const READ_TOOLS = new Set(['read_file', 'outline_file', 'search_files', 'list_files', 'view_image', 'ask_user', 'web_search', 'web_fetch']);

export function isLeadRun(request: AgentRunRequest): boolean {
  return Boolean(request.permissionRules?.some((rule) => rule.id === 'lead-read-only' && rule.effect === 'deny'));
}

export function leadToolAllowed(name: string): boolean { return READ_TOOLS.has(name); }

/** Enforce the same offered tool set across every provider protocol. */
export function toolsForLead(request: AgentRunRequest, definitions: readonly unknown[]): readonly unknown[] {
  return isLeadRun(request) ? definitions.filter((definition) => {
    const name = definition && typeof definition === 'object' ? (definition as { name?: unknown }).name : null;
    return typeof name === 'string' && leadToolAllowed(name);
  }) : definitions;
}
