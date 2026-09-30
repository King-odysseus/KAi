import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evalCaseSchema,
  evalResultSchema,
  type AgentRunRequest,
  type AgentRunResult,
  type EvalCase,
  type EvalCaseInput,
  type EvalOverview,
  type EvalResult,
  type EvalRunInput,
} from '@kai/contracts';
import { addWorktree, changedFiles, commitWorktree, headCommit, removeWorktree, repositoryFor } from './git-worktrees';

const MAX_RESULTS_PER_PROJECT = 200;
const OUTPUT_TAIL = 4_000;

interface EvalFile {
  cases: EvalCase[];
  results: EvalResult[];
}

export class EvalStore {
  constructor(private readonly directory: string) {}

  private fileFor(projectId: string): string {
    if (!/^[\w.-]+$/.test(projectId)) throw new Error('Invalid project id.');
    return path.join(this.directory, `${projectId}.json`);
  }

  async read(projectId: string): Promise<EvalFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(projectId), 'utf8')) as { cases?: unknown[]; results?: unknown[] };
      return {
        cases: (parsed.cases ?? []).flatMap((item) => {
          const value = evalCaseSchema.safeParse(item);
          return value.success ? [value.data] : [];
        }),
        results: (parsed.results ?? []).flatMap((item) => {
          const value = evalResultSchema.safeParse(item);
          return value.success ? [value.data] : [];
        }),
      };
    } catch {
      return { cases: [], results: [] };
    }
  }

  async write(projectId: string, file: EvalFile): Promise<void> {
    const target = this.fileFor(projectId);
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(`${target}.tmp`, JSON.stringify({ ...file, results: file.results.slice(0, MAX_RESULTS_PER_PROJECT) }), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }
}

export interface EvalPorts {
  project(projectId: string): Promise<{ id: string; name: string; path: string }>;
  /** Makes a conversation for one eval run, kept out of the user's list. Returns its id. */
  createConversation(projectId: string, title: string): Promise<string>;
  runAgent(request: AgentRunRequest, cwd: string): Promise<AgentRunResult>;
  runCheck(cwd: string, command: string): Promise<{ exitCode: number | null; output: string }>;
  now?(): Date;
}

/**
 * Replays a saved task. Each run starts from the same commit in a disposable copy of the project, lets one agent
 * attempt the task, and then decides pass or fail by the case's check command. The user's own files are never touched.
 */
export class DesktopEvals {
  constructor(
    private readonly store: EvalStore,
    private readonly ports: EvalPorts,
  ) {}

  async overview(projectId: string): Promise<EvalOverview> {
    const file = await this.store.read(projectId);
    return { cases: file.cases, results: file.results };
  }

  async saveCase(input: EvalCaseInput): Promise<EvalCase> {
    const project = await this.ports.project(input.projectId);
    const baseRef = input.baseRef?.trim() || (await headCommit(project.path).catch(() => ''));
    if (!baseRef) throw new Error('This project has no commits yet, so an eval has nothing to start from. Commit once, then save the eval.');
    const file = await this.store.read(input.projectId);
    const created: EvalCase = { ...input, baseRef, id: `eval_${randomUUID()}`, createdAt: (this.ports.now?.() ?? new Date()).toISOString() };
    await this.store.write(input.projectId, { ...file, cases: [...file.cases, created] });
    return created;
  }

  async deleteCase(projectId: string, caseId: string): Promise<boolean> {
    const file = await this.store.read(projectId);
    const cases = file.cases.filter((item) => item.id !== caseId);
    if (cases.length === file.cases.length) return false;
    await this.store.write(projectId, { cases, results: file.results.filter((result) => result.caseId !== caseId) });
    return true;
  }

  async run(input: EvalRunInput): Promise<EvalResult> {
    const project = await this.ports.project(input.projectId);
    const file = await this.store.read(input.projectId);
    const testCase = file.cases.find((item) => item.id === input.caseId);
    if (!testCase) throw new Error('That eval no longer exists.');
    const repository = await repositoryFor(project.path);
    if (!repository) throw new Error('Evals need a Git project with at least one commit.');

    const startedAt = this.ports.now?.() ?? new Date();
    const directory = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kai-eval-')), 'work');
    let result: EvalResult;
    try {
      await addWorktree(repository.root, directory, testCase.baseRef);
      const cwd = repository.prefix ? path.join(directory, repository.prefix) : directory;
      const conversationId = await this.ports.createConversation(project.id, `Eval: ${testCase.name} (${input.agent})`);
      const run = await this.ports.runAgent(
        {
          conversationId,
          prompt: testCase.prompt,
          agent: input.agent,
          execution: input.execution,
          route: input.route,
          // The copy is disposable and the user started this run knowing it acts without asking.
          autonomy: 'full',
          freshSession: true,
          ...(input.model ? { model: input.model } : {}),
        },
        cwd,
      );
      const check = await this.ports.runCheck(cwd, testCase.check);
      const commit = await commitWorktree(directory, 'KAI eval result').catch(() => testCase.baseRef);
      const changed = await changedFiles(directory, testCase.baseRef, commit).catch(() => []);
      result = {
        id: `evalrun_${randomUUID()}`,
        caseId: testCase.id,
        projectId: project.id,
        agent: input.agent,
        execution: input.execution,
        route: input.route,
        ...(input.model ? { model: input.model } : {}),
        startedAt: startedAt.toISOString(),
        durationMs: (this.ports.now?.() ?? new Date()).getTime() - startedAt.getTime(),
        agentCompleted: run.status === 'completed',
        passed: check.exitCode === 0,
        checkExitCode: check.exitCode,
        filesChanged: changed.length,
        ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
        ...(run.error ? { error: run.error.slice(0, 2_000) } : {}),
        outputTail: check.output.slice(-OUTPUT_TAIL),
      };
    } catch (error) {
      result = {
        id: `evalrun_${randomUUID()}`,
        caseId: testCase.id,
        projectId: project.id,
        agent: input.agent,
        execution: input.execution,
        route: input.route,
        ...(input.model ? { model: input.model } : {}),
        startedAt: startedAt.toISOString(),
        durationMs: (this.ports.now?.() ?? new Date()).getTime() - startedAt.getTime(),
        agentCompleted: false,
        passed: false,
        checkExitCode: null,
        filesChanged: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        outputTail: '',
      };
    } finally {
      await removeWorktree(repository.root, directory).catch(() => undefined);
      await fs.rm(path.dirname(directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
    const latest = await this.store.read(input.projectId);
    await this.store.write(input.projectId, { cases: latest.cases, results: [result, ...latest.results] });
    return result;
  }
}
