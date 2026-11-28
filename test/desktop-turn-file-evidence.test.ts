import { describe, expect, it, vi } from 'vitest';
import type { PersistedEvent, TurnFileChange } from '@kai/contracts';
vi.mock('../apps/desktop/src/main/project-files', () => ({ readProjectFile: vi.fn(async (_root, file) => { if (file === 'missing.ts') throw new Error('Unavailable'); return { hash: `actual-${file}` }; }) }));
import { captureTurnFileEvidence } from '../apps/desktop/src/main/turn-file-evidence';
import { readProjectFile } from '../apps/desktop/src/main/project-files';

describe('frozen file evidence', () => {
  it('records actual reader hashes, not model-reported output, and includes writes without Git', async () => {
    const events = [{ type: 'tool.call', name: 'write_file', status: 'completed', input: { path: 'src/form.ts' }, output: { hash: 'made-up' } }, { type: 'tool.call', name: 'read_file', status: 'completed', input: { path: 'not-edited.ts' } }] as PersistedEvent[];
    expect(await captureTurnFileEvidence('/project', [], events)).toEqual([{ path: 'src/form.ts', hash: 'actual-src/form.ts' }]);
    expect(readProjectFile).toHaveBeenCalledWith('/project', 'src/form.ts');
  });
  it('deduplicates files, records unavailable evidence and bounds the scan', async () => {
    const changes = Array.from({ length: 60 }, (_, index) => ({ path: index ? `file-${index}.ts` : 'missing.ts', added: 1, removed: 0 })) as TurnFileChange[];
    const result = await captureTurnFileEvidence('/project', changes, []);
    expect(result).toHaveLength(50); expect(result[0]).toEqual({ path: 'missing.ts', hash: null });
  });
});
