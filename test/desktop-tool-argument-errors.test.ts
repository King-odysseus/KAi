import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { DesktopProjectToolRuntime } from '../apps/desktop/src/main/project-tools';

describe('a tool call with bad arguments', () => {
  it('tells the model what is missing instead of dumping a validation report', async () => {
    const runtime = new DesktopProjectToolRuntime(os.tmpdir());
    const result = await runtime.execute('run_command', {});
    expect(result.ok).toBe(false);
    const message = String((result.output as { error: string }).error);
    expect(message).toContain('"command" is required');
    expect(message).toContain('You sent no arguments.');
    expect(message).toContain('Call run_command again');
    expect(message).not.toContain('invalid_type');
  });

  it('shows what was sent when some arguments were given', async () => {
    const runtime = new DesktopProjectToolRuntime(os.tmpdir());
    const result = await runtime.execute('read_file', { file: 'a.ts' });
    const message = String((result.output as { error: string }).error);
    expect(message).toContain('"path" is required');
    expect(message).toContain('You sent: {');
  });
});
