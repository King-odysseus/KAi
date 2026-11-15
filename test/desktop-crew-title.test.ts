import { describe, expect, it } from 'vitest';
import { crewTitle } from '../apps/desktop/src/renderer/src/crew-title';

describe('naming a crew in a list', () => {
  it('reduces a quoted file path to its file name, keeping what was asked of it', () => {
    expect(crewTitle('"C:\\Users\\Mega-Mind\\Documents\\WebDev Projects\\WorkSpace\\docs\\zuricopilot-plan.md"  implement this plan'))
      .toBe('zuricopilot-plan.md implement this plan');
  });

  it('does the same for an unquoted path, and for forward slashes', () => {
    expect(crewTitle('build from /home/dev/projects/zuri/docs/plan.md please')).toBe('build from plan.md please');
  });

  it('leaves an ordinary goal alone, and clips a long one', () => {
    expect(crewTitle('Build the Zuri log viewer')).toBe('Build the Zuri log viewer');
    const long = crewTitle('x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('gives an empty goal a name', () => {
    expect(crewTitle('   ')).toBe('Untitled crew');
  });

  it('tells two crews on different plans apart, which the old clipped path could not', () => {
    const a = crewTitle('"C:\\Users\\Mega-Mind\\Documents\\WebDev Projects\\WorkSpace\\docs\\plan-a.md" implement this');
    const b = crewTitle('"C:\\Users\\Mega-Mind\\Documents\\WebDev Projects\\WorkSpace\\docs\\plan-b.md" implement this');
    expect(a).not.toBe(b);
  });
});
