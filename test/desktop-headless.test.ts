import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../packages/contracts/src';
import {
  isOwnTempFile,
  jobFileFromArgv,
  processHeadlessJobFile,
  runHeadlessJob,
  type HeadlessPorts,
} from '../apps/desktop/src/main/headless';
// The command ships as plain JavaScript beside the app, so it is imported as a module here.
// @ts-expect-error - no type declarations for the shipped script
import { findKaiExecutable, parseArguments } from '../apps/desktop/resources/kai-cli/kai.mjs';

describe('kai command line', () => {
  it('parses a run with options and a multi-word prompt', () => {
    const parsed = parseArguments(['run', '--agent', 'codex', '--full', '-C', 'app', 'fix', 'the', 'tests'], '/work');
    expect(parsed.prompt).toBe('fix the tests');
    expect(parsed.options).toMatchObject({ agent: 'codex', autonomy: 'full', execution: 'cli', route: 'direct' });
    expect(path.normalize(parsed.options.project)).toBe(path.normalize(path.resolve('/work', 'app')));
  });

  it('defaults to a read-only claude run in the current folder, and reads a prompt from stdin', () => {
    const parsed = parseArguments(['-'], '/work', () => 'from stdin');
    expect(parsed.prompt).toBe('from stdin');
    expect(parsed.options).toMatchObject({ agent: 'claude', autonomy: 'plan', project: '/work' });
  });

  it('reports bad usage instead of guessing', () => {
    expect(parseArguments(['run'], '/w').error).toMatch(/what the agent should do/);
    expect(parseArguments(['run', '--agent', 'gpt', 'x'], '/w').error).toMatch(/Unknown agent/);
    expect(parseArguments(['run', '--nope', 'x'], '/w').error).toMatch(/Unknown option/);
    expect(parseArguments(['run', '--agent'], '/w').error).toMatch(/needs a value/);
    expect(parseArguments(['run', '--timeout', '0', 'x'], '/w').error).toMatch(/timeout/);
    expect(parseArguments(['--help'], '/w').help).toBe(true);
  });

  it('finds KAI from KAI_EXE first, then the usual install', () => {
    const present = new Set(['C:\\custom\\KAI.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\KAI\\KAI.exe']);
    const exists = (candidate: string): boolean => present.has(candidate);
    expect(findKaiExecutable({ KAI_EXE: 'C:\\custom\\KAI.exe' }, 'win32', 'C:\\app\\resources\\kai-cli', exists)).toBe('C:\\custom\\KAI.exe');
    expect(findKaiExecutable({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\elsewhere', (candidate: string) => candidate.endsWith('Programs\\KAI\\KAI.exe') || candidate.endsWith('Programs/KAI/KAI.exe'))).toMatch(/KAI\.exe$/);
    expect(findKaiExecutable({}, 'win32', 'C:\\x', () => false)).toBeNull();
  });
});

describe('headless jobs', () => {
  let directory: string;
  let calls: AgentRunRequest[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'kai-headless-'));
    calls = [];
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

  const ports = (): HeadlessPorts => ({
    projects: async () => [{ id: 'p1', name: 'demo', path: directory }],
    createConversation: async () => 'conv1',
    run: async (request) => {
      calls.push(request);
      return { conversation: {} as never, status: 'completed', output: 'All done', costUsd: 0.5 };
    },
  });
  const baseJob = (overrides: Record<string, unknown> = {}) => ({ id: 'j1', prompt: 'do it', project: directory, resultFile: path.join(tmpdir(), 'kai-result-test.json'), ...overrides });

  it('finds the job file on a command line', () => {
    expect(jobFileFromArgv(['KAI.exe', '--kai-job', 'C:\\t\\kai-job-1.json'])).toBe('C:\\t\\kai-job-1.json');
    expect(jobFileFromArgv(['KAI.exe'])).toBeNull();
    expect(jobFileFromArgv(['KAI.exe', '--kai-job', '--other'])).toBeNull();
  });

  it('only trusts files made by the command in the temp folder', () => {
    expect(isOwnTempFile(path.join(tmpdir(), 'kai-job-1.json'), 'kai-job-')).toBe(true);
    expect(isOwnTempFile(path.join(tmpdir(), 'other.json'), 'kai-job-')).toBe(false);
    expect(isOwnTempFile(path.join(tmpdir(), 'sub', 'kai-job-1.json'), 'kai-job-')).toBe(false);
    expect(isOwnTempFile(path.join(tmpdir(), 'kai-job-1.txt'), 'kai-job-')).toBe(false);
    expect(isOwnTempFile(path.join(tmpdir(), '..', 'kai-job-1.json'), 'kai-job-')).toBe(false);
  });

  it('runs a prompt on an open project as a plan-mode run by default', async () => {
    const result = await runHeadlessJob(ports(), { agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', ...baseJob() } as never);
    expect(result).toMatchObject({ status: 'completed', output: 'All done', conversationId: 'conv1', costUsd: 0.5 });
    expect(calls[0]).toMatchObject({ prompt: 'do it', autonomy: 'plan', freshSession: true, agent: 'claude' });
  });

  it('refuses a folder that is not open in KAI', async () => {
    const result = await runHeadlessJob(ports(), { agent: 'claude', execution: 'cli', route: 'direct', autonomy: 'plan', ...baseJob({ project: path.join(directory, 'nope') }) } as never);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not a project in KAI');
    expect(calls).toEqual([]);
  });

  it('reads a job file, writes the result file and removes the job', async () => {
    const id = `t${Date.now()}`;
    const jobFile = path.join(tmpdir(), `kai-job-${id}.json`);
    const resultFile = path.join(tmpdir(), `kai-result-${id}.json`);
    await writeFile(jobFile, JSON.stringify(baseJob({ resultFile, autonomy: 'full', agent: 'codex' })));

    await processHeadlessJobFile(ports(), jobFile);

    expect(JSON.parse(await readFile(resultFile, 'utf8'))).toMatchObject({ status: 'completed', output: 'All done' });
    expect(calls[0]).toMatchObject({ autonomy: 'full', agent: 'codex' });
    expect(existsSync(jobFile)).toBe(false);
    await rm(resultFile, { force: true });
  });

  it('still writes a result when the job is invalid, and never runs an agent for it', async () => {
    const id = `bad${Date.now()}`;
    const jobFile = path.join(tmpdir(), `kai-job-${id}.json`);
    const resultFile = path.join(tmpdir(), `kai-result-${id}.json`);
    await writeFile(jobFile, JSON.stringify({ ...baseJob({ resultFile }), autonomy: 'autoEdit' }));

    await processHeadlessJobFile(ports(), jobFile);

    const result = JSON.parse(await readFile(resultFile, 'utf8')) as { status: string; error: string };
    expect(result.status).toBe('failed');
    expect(result.error).toContain('not valid');
    expect(calls).toEqual([]);
    await rm(resultFile, { force: true });
  });

  it('will not write a result anywhere except the command\'s own temp files', async () => {
    const id = `evil${Date.now()}`;
    const jobFile = path.join(tmpdir(), `kai-job-${id}.json`);
    const target = path.join(directory, 'overwrite-me.json');
    await writeFile(jobFile, JSON.stringify(baseJob({ resultFile: target })));

    await processHeadlessJobFile(ports(), jobFile);

    expect(existsSync(target)).toBe(false);
    expect(calls).toEqual([]);
  });
});
