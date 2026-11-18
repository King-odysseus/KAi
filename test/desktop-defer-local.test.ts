import { describe, expect, it } from 'vitest';
import { deferExternalTools } from '../apps/desktop/src/main/deferred-tools';
import type { ExternalToolPort } from '../apps/desktop/src/main/project-tools';

const few: ExternalToolPort = {
  definitions: async () => [
    { type: 'function', name: 'mcp_blender_scene', description: 'Read the Blender scene', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'mcp_blender_render', description: 'Render the Blender scene', parameters: { type: 'object', properties: {} } },
  ],
  policy: () => ({ decision: 'allow' }),
  execute: async (name) => ({ ok: true, output: `${name} ran` }),
};

describe('outside tools for a small model', () => {
  it('shows a short list as it is, for a model that can afford it', async () => {
    const names = (await deferExternalTools(few)!.definitions()).map((definition) => (definition as { name: string }).name);
    expect(names).toEqual(['mcp_blender_scene', 'mcp_blender_render']);
  });

  it('offers only the search tool when forced, and loads a tool by name when asked', async () => {
    const port = deferExternalTools(few, true)!;
    const offered = (await port.definitions()).map((definition) => (definition as { name: string }).name);
    expect(offered).toHaveLength(1);
    expect(offered[0]).not.toMatch(/^mcp_blender/);
    const result = await port.execute(offered[0]!, { query: 'select:mcp_blender_render' });
    expect(result?.ok).toBe(true);
    expect(JSON.stringify(result?.output)).toContain('mcp_blender_render');
  });
});
