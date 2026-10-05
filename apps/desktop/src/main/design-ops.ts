import { DESIGN_TOOLS, errorIn, unwrapReply, type DesignPorts } from './design-source';

/**
 * The writes KAI makes to open-pencil on one page's behalf: deleting the page a screen was drawn on, and renaming
 * one so the checklist can match it again. These are the page-level verbs the Design tab was missing — the build
 * loop can only ask an agent to delete "whatever is in the way", which is a guess, while these act on the exact node
 * the pull identified.
 *
 * A page is a node, so there is no `delete_page`/`rename_page`; `delete_node` and `rename_node` take the page id
 * `list_pages` returns. They live here rather than in `design-source.ts` so the read layer and the write layer stay
 * separate, and so nothing that only reads the design pulls the write verbs in with it.
 */

/**
 * One page tool call, unwrapping the `{ error }` a failed MCP call resolves with. open-pencil reports failure in the
 * payload rather than by throwing, so a call that returned at all still has to be read before it is believed.
 */
async function callPageTool(ports: DesignPorts, tool: string, verb: string, input: Record<string, unknown>): Promise<void> {
  const value = unwrapReply(await ports.call(tool, input));
  const failure = value && typeof value === 'object' && !Array.isArray(value) ? errorIn(value as Record<string, unknown>) : null;
  if (failure) throw new Error(`open-pencil could not ${verb} the page: ${failure}`);
}

/** Deletes one page from open-pencil, with everything drawn on it. This cannot be undone from KAI. */
export async function deletePageNode(ports: DesignPorts, pageId: string): Promise<void> {
  await callPageTool(ports, DESIGN_TOOLS.deleteNode, 'delete', { id: pageId });
}

/** Renames one page in open-pencil so its name matches the pages list, which is what makes a row read as drawn. */
export async function renamePageNode(ports: DesignPorts, pageId: string, name: string): Promise<void> {
  await callPageTool(ports, DESIGN_TOOLS.renameNode, 'rename', { id: pageId, name });
}
