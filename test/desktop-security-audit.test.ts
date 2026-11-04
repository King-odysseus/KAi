import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SECURITY_SCAN_RECIPES,
  parseSecurityFindingsReport,
  securityAuditPrompt,
  securityFindingFingerprint,
  securityFindingSchema,
  type SecurityFinding,
} from '../packages/contracts/src';
import { NodeFileSystem } from '../packages/runtime/src';
import { SecurityFindingsStore } from '../apps/desktop/src/main/security-findings-store';
import { runSecurityPrepass } from '../apps/desktop/src/main/security-prepass';
import { createKaiProjectTools, type KaiProjectPorts } from '../apps/desktop/src/main/kai-project-tools';
import { StudioArtifacts } from '../apps/desktop/src/main/artifacts';
import { StudioBoardStore } from '../apps/desktop/src/main/board';
import { SpecStore } from '../apps/desktop/src/main/spec-store';

/**
 * The Security Auditor end to end, minus the model: the identity a finding keeps across scans, the store that
 * applies it, the tool an agent files with, and the prompt/report contract the run is held to.
 */

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-security-'));
  directories.push(dir);
  return dir;
}

async function findingsStore(): Promise<SecurityFindingsStore> {
  return new SecurityFindingsStore(path.join(await tempDir(), 'security-findings.json'), new NodeFileSystem());
}

function finding(extra: Partial<SecurityFinding> = {}): SecurityFinding {
  return securityFindingSchema.parse({
    id: 'f1',
    createdAt: '2026-10-01T10:00:00.000Z',
    severity: 'high',
    vulnClass: 'sql-injection',
    title: 'Search endpoint concatenates raw input into SQL',
    location: 'src/api/search.ts:18',
    evidence: "GET /api/search?q=' OR '1'='1 returned every row.",
    conceptCard: 'SQL injection: input reaches the query as text instead of a bound value.',
    ...extra,
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
});

describe('a finding keeps its identity across scans', () => {
  it('ignores a line move, letter case and extra whitespace', () => {
    const first = securityFindingFingerprint(finding());
    const moved = securityFindingFingerprint(finding({
      location: 'src/api/search.ts:240',
      title: '  search   endpoint CONCATENATES raw input into sql ',
    }));
    expect(moved).toBe(first);
  });

  it('tells different classes and different files apart', () => {
    const base = securityFindingFingerprint(finding());
    expect(securityFindingFingerprint(finding({ vulnClass: 'broken-auth' }))).not.toBe(base);
    expect(securityFindingFingerprint(finding({ location: 'src/api/users.ts:4' }))).not.toBe(base);
  });
});

describe('the findings store', () => {
  it('updates the same issue instead of appending a duplicate', async () => {
    const store = await findingsStore();
    const saved = await store.add({
      severity: 'medium',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:18',
      evidence: 'First sighting.',
      conceptCard: 'What SQL injection is.',
    });
    const again = await store.add({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:42',
      evidence: 'Still reproduces after the line moved.',
      conceptCard: 'What SQL injection is.',
    });

    expect(again.id).toBe(saved.id);
    expect(again.severity).toBe('high');
    expect(again.evidence).toContain('line moved');
    expect(again.createdAt).toBe(saved.createdAt);
    expect(again.lastSeenAt).toBeDefined();
    expect(await store.list()).toHaveLength(1);
  });

  it('reopens a fixed finding that a scan sees again, and leaves a wont-fix alone', async () => {
    const store = await findingsStore();
    const fixed = await store.add({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:18',
      evidence: 'First sighting.',
      conceptCard: 'What SQL injection is.',
      status: 'open',
    });
    await store.updateStatus({ id: fixed.id, status: 'fixed' });
    const reopened = await store.add({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:18',
      evidence: 'Came back.',
      conceptCard: 'What SQL injection is.',
    });
    expect(reopened.status).toBe('open');

    await store.updateStatus({ id: fixed.id, status: 'wont-fix' });
    const kept = await store.add({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:18',
      evidence: 'Seen again.',
      conceptCard: 'What SQL injection is.',
    });
    expect(kept.status).toBe('wont-fix');
  });

  it('updates a record by id even when the verify pass reworded it', async () => {
    const store = await findingsStore();
    const saved = await store.add(finding());
    const verified = await store.add({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint still concatenates raw input',
      location: 'src/api/search.ts:18',
      evidence: 'Re-tested.',
      conceptCard: 'What SQL injection is.',
      id: saved.id,
      status: 'fixed',
      lastVerifiedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(verified.id).toBe(saved.id);
    expect(verified.status).toBe('fixed');
    expect(verified.title).toBe('Search endpoint still concatenates raw input');
    expect(verified.lastVerifiedAt).toBe('2026-10-02T10:00:00.000Z');
    expect(await store.list()).toHaveLength(1);
  });
});

describe('the save_security_finding tool', () => {
  async function ports(store?: SecurityFindingsStore): Promise<KaiProjectPorts> {
    const root = await tempDir();
    const spec = new SpecStore();
    const projectRoot = (): Promise<string> => Promise.resolve(root);
    const now = (): string => '2026-10-01T10:00:00.000Z';
    const nothing = (): Promise<null> => Promise.resolve(null);
    return {
      projectId: 'current',
      projectRoot,
      spec,
      artifacts: new StudioArtifacts({ spec, projectRoot, now }),
      board: new StudioBoardStore({ spec, projectRoot, dirtyFiles: nothing, hashFile: nothing, run: nothing, now }),
      ...(store ? { findings: store } : {}),
      now,
    };
  }

  it('is offered only when the server was given a findings file', async () => {
    expect(createKaiProjectTools(await ports()).map((tool) => tool.name)).not.toContain('save_security_finding');
    expect(createKaiProjectTools(await ports(await findingsStore())).map((tool) => tool.name)).toContain('save_security_finding');
  });

  it('writes the record the panel reads', async () => {
    const store = await findingsStore();
    const tool = createKaiProjectTools(await ports(store)).find((candidate) => candidate.name === 'save_security_finding');
    if (!tool) throw new Error('save_security_finding was not offered.');
    const result = await tool.run({
      severity: 'high',
      vulnClass: 'sql-injection',
      title: 'Search endpoint concatenates raw input into SQL',
      location: 'src/api/search.ts:18',
      evidence: "GET /api/search?q=' OR '1'='1 returned every row.",
      conceptCard: 'SQL injection: input reaches the query as text.',
    });
    expect(result).toMatchObject({ status: 'open' });
    expect((await store.list())[0]).toMatchObject({ vulnClass: 'sql-injection', severity: 'high' });
  });
});

describe('the audit prompt', () => {
  it('states the local boundary, the scope and the report contract', () => {
    const prompt = securityAuditPrompt({ profile: 'injection', target: 'src/api/search.ts', projectName: 'Demo' });
    expect(prompt).toContain('Act as the $security-auditor skill.');
    expect(prompt).toContain('Target: src/api/search.ts');
    expect(prompt).toContain('Hard boundary: local only');
    expect(prompt).toContain('save_security_finding');
    expect(prompt).toContain('```json kai-security-findings');
    const injection = SECURITY_SCAN_RECIPES.find((recipe) => recipe.id === 'injection');
    expect(injection).toBeDefined();
    expect(prompt).toContain(injection?.instructions.slice(0, 40));
  });

  it('carries the deterministic pre-pass facts when there are any', () => {
    const prompt = securityAuditPrompt({ profile: 'secrets', prepass: 'Deterministic pre-pass: src/config.ts:1 — OpenAI-style key' });
    expect(prompt).toContain('src/config.ts:1 — OpenAI-style key');
    expect(securityAuditPrompt({ profile: 'secrets' })).not.toContain('Deterministic pre-pass');
  });

  it('names the finding a verify pass must re-test', () => {
    const prompt = securityAuditPrompt({ profile: 'verify', target: '', finding: finding() });
    expect(prompt).toContain('Re-test one existing finding only');
    expect(prompt).toContain(finding().title);
    expect(prompt).toContain(finding().location);
    expect(prompt).toContain('"fixed"');
  });
});

describe('the deterministic pre-pass', () => {
  it('finds a credential-shaped value and never repeats it in full', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'config.ts'), 'const apiKey = "sk-abcdefghijklmnopqrstuvwx";\n', 'utf8');

    const pass = await runSecurityPrepass(root);
    expect(pass.secretsFound).toBe(1);
    expect(pass.text).toContain('src/config.ts:1');
    expect(pass.text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(pass.text).toContain('…[redacted]…');
  });

  it('skips dependency folders and says so when there is nothing to report', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'const token = "sk-abcdefghijklmnopqrstuvwx";\n', 'utf8');
    await fs.writeFile(path.join(root, 'index.js'), 'export const answer = 42;\n', 'utf8');

    const pass = await runSecurityPrepass(root);
    expect(pass.secretsFound).toBe(0);
    expect(pass.text).toContain('found no credential-shaped values');
  });
});

describe('the report block', () => {
  const item = {
    severity: 'high',
    vulnClass: 'sql-injection',
    title: 'Search endpoint concatenates raw input into SQL',
    location: 'src/api/search.ts:18',
    evidence: 'Reproduced.',
    conceptCard: 'What it is and how to fix it.',
  };

  it('reads the last block, so a corrected restatement wins', () => {
    const output = [
      'Earlier draft:',
      '```json kai-security-findings',
      JSON.stringify([{ ...item, severity: 'low' }]),
      '```',
      'Final:',
      '```json kai-security-findings',
      JSON.stringify([item]),
      '```',
    ].join('\n');
    expect(parseSecurityFindingsReport(output)).toEqual([item]);
  });

  it('returns nothing for a missing or malformed block rather than throwing', () => {
    expect(parseSecurityFindingsReport('No findings.')).toEqual([]);
    expect(parseSecurityFindingsReport('```json kai-security-findings\n{not json}\n```')).toEqual([]);
  });

  it('drops an item that is missing required evidence', () => {
    const output = ['```json kai-security-findings', JSON.stringify([{ ...item, evidence: '' }]), '```'].join('\n');
    expect(parseSecurityFindingsReport(output)).toEqual([]);
  });

  it('accepts a status a verify pass reports', () => {
    const output = ['```json kai-security-findings', JSON.stringify([{ ...item, status: 'fixed' }]), '```'].join('\n');
    expect(parseSecurityFindingsReport(output)[0]).toMatchObject({ status: 'fixed' });
  });
});
