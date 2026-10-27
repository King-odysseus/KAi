import { describe, expect, it } from 'vitest';
import { DESIGN_TOOLS, type DesignPorts } from '../apps/desktop/src/main/design-source';
import { switchToPage } from '../apps/desktop/src/main/design-ops';

function portsReturning(reply: unknown): { ports: DesignPorts; calls: Array<{ tool: string; input: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    ports: {
      endpoint: () => 'http://127.0.0.1:7600',
      async call(tool, input) {
        calls.push({ tool, input });
        return [{ type: 'text', text: JSON.stringify(reply) }];
      },
    },
  };
}

describe('switching open-pencil to one page', () => {
  it('calls switch_page with the page id, the shape open-pencil actually takes', async () => {
    const { ports, calls } = portsReturning({ ok: true });
    await switchToPage(ports, 'node-checkout');
    expect(calls).toEqual([{ tool: DESIGN_TOOLS.switchPage, input: { page: 'node-checkout' } }]);
  });

  it('throws open-pencil\'s own reason when the switch is refused', async () => {
    const { ports } = portsReturning({ error: 'no such page' });
    await expect(switchToPage(ports, 'missing')).rejects.toThrow(/no such page/);
  });
});
