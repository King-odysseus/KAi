import { describe, expect, it } from 'vitest';
import { commandMatchesPrefix, globMatches } from '../apps/desktop/src/main/glob-match';
import { applyPermissionRules } from '../apps/desktop/src/main/permission-rules';

describe('permission rule matching', () => {
  it('matches tool globs and path globs', () => {
    expect(globMatches('*', 'run_command')).toBe(true);
    expect(globMatches('mcp_*', 'mcp_playwright_navigate')).toBe(true);
    expect(globMatches('mcp_*', 'run_command')).toBe(false);
    expect(globMatches('src/**', 'src/deep/file.ts')).toBe(true);
    expect(globMatches('src/**/test.ts', 'src/test.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/deep/file.ts')).toBe(false);
  });

  it('matches command prefixes at a token boundary', () => {
    expect(commandMatchesPrefix('git push --force', 'git push')).toBe(true);
    expect(commandMatchesPrefix('git pushd', 'git push')).toBe(false);
    expect(commandMatchesPrefix('npm   test', 'npm test')).toBe(true);
  });
});

describe('permission rule precedence', () => {
  it('never relaxes a base refusal', () => {
    const policy = applyPermissionRules({ decision: 'deny', reason: 'Plan mode.' }, [
      { id: 'allow-all', effect: 'allow', tools: ['*'], commands: [], paths: [] },
    ], { tool: 'run_command', input: { command: 'ls' } });
    expect(policy).toEqual({ decision: 'deny', reason: 'Plan mode.' });
  });

  it('tightens an allowed tool to ask, and relaxes an ask to allow', () => {
    const ask = applyPermissionRules({ decision: 'allow' }, [
      { id: 'ask-push', effect: 'ask', tools: ['run_command'], commands: ['git push'], paths: [], note: 'Publishing needs a look.' },
    ], { tool: 'run_command', input: { command: 'git push origin main' } });
    expect(ask).toEqual({ decision: 'ask', title: 'Allow run_command?', detail: 'Publishing needs a look.', risk: 'medium' });

    const allow = applyPermissionRules({ decision: 'ask', title: 'Run?', detail: '', risk: 'high' }, [
      { id: 'allow-tests', effect: 'allow', tools: ['run_command'], commands: ['npm test'], paths: [] },
    ], { tool: 'run_command', input: { command: 'npm test -- --watch=false' } });
    expect(allow).toEqual({ decision: 'allow' });
  });

  it('lets deny win over ask and allow when several rules match', () => {
    const policy = applyPermissionRules({ decision: 'allow' }, [
      { id: 'allow', effect: 'allow', tools: ['run_command'], commands: [], paths: [] },
      { id: 'ask', effect: 'ask', tools: ['run_command'], commands: ['git push'], paths: [] },
      { id: 'deny', effect: 'deny', tools: ['run_command'], commands: ['git push'], paths: [], note: 'Never publish from an agent.' },
    ], { tool: 'run_command', input: { command: 'git push --force' } });
    expect(policy).toEqual({ decision: 'deny', reason: 'Never publish from an agent.' });
  });

  it('matches paths on file tools and ignores unrelated tools', () => {
    const denied = applyPermissionRules({ decision: 'allow' }, [
      { id: 'no-migrations', effect: 'deny', tools: [], commands: [], paths: ['db/migrations/**'], note: 'Migrations are hand-written.' },
    ], { tool: 'write_file', input: { path: 'db/migrations/001.sql' } });
    expect(denied.decision).toBe('deny');

    const untouched = applyPermissionRules({ decision: 'allow' }, [
      { id: 'no-migrations', effect: 'deny', tools: [], commands: [], paths: ['db/migrations/**'] },
    ], { tool: 'read_file', input: { path: 'src/app.ts' } });
    expect(untouched).toEqual({ decision: 'allow' });
  });

  it('requires every matcher group in a rule to match', () => {
    const policy = applyPermissionRules({ decision: 'allow' }, [
      { id: 'tests-only', effect: 'ask', tools: ['run_command'], commands: ['npm test'], paths: [] },
    ], { tool: 'run_command', input: { command: 'npm publish' } });
    expect(policy).toEqual({ decision: 'allow' });
  });
});
