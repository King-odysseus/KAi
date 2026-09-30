import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { agentIdSchema, routeModeSchema, type AgentRunRequest, type AgentRunResult } from '@kai/contracts';

/**
 * The `kai` command: another program (a script, CI, another agent) asks KAI to run one prompt on a project that is
 * already in KAI, and reads the outcome from a file. The command line hands over a job file and a result file, both
 * of which must be KAI's own temp files, so this cannot be pointed at arbitrary paths.
 */
export const JOB_FLAG = '--kai-job';
export const JOB_PREFIX = 'kai-job-';
export const RESULT_PREFIX = 'kai-result-';

export const headlessJobSchema = z
  .object({
    id: z.string().min(1).max(100),
    prompt: z.string().trim().min(1).max(20_000),
    /** A folder that is already open in KAI. */
    project: z.string().min(1).max(2_000),
    agent: agentIdSchema.default('claude'),
    execution: z.enum(['cli', 'api']).default('cli'),
    route: routeModeSchema.default('direct'),
    /** A headless run has nobody to answer approvals, so it either only reads or is trusted to act. */
    autonomy: z.enum(['plan', 'full']).default('plan'),
    model: z.string().trim().max(100).optional(),
    resultFile: z.string().min(1).max(2_000),
  })
  .strict();
export type HeadlessJob = z.infer<typeof headlessJobSchema>;

export interface HeadlessResult {
  status: 'completed' | 'failed';
  output: string;
  error?: string;
  conversationId?: string;
  costUsd?: number;
}

export interface HeadlessPorts {
  projects(): Promise<Array<{ id: string; name: string; path: string }>>;
  createConversation(projectId: string, title: string): Promise<string>;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

/** The job file named on a command line, or null when this launch is not a `kai` job. */
export function jobFileFromArgv(argv: readonly string[]): string | null {
  const index = argv.indexOf(JOB_FLAG);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

/** True when the path is a file KAI's command would have made: directly in the temp folder, with the right prefix. */
export function isOwnTempFile(file: string, prefix: string, tempDirectory: string = os.tmpdir()): boolean {
  const resolved = path.resolve(file);
  const same = (left: string, right: string): boolean => (process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right);
  return same(path.dirname(resolved), path.resolve(tempDirectory)) && path.basename(resolved).startsWith(prefix) && resolved.endsWith('.json');
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function runHeadlessJob(ports: HeadlessPorts, job: HeadlessJob): Promise<HeadlessResult> {
  const projects = await ports.projects();
  const wanted = await fs.realpath(job.project).catch(() => path.resolve(job.project));
  const project = projects.find((candidate) => samePath(candidate.path, wanted) || samePath(candidate.path, job.project));
  if (!project) {
    return { status: 'failed', output: '', error: `${job.project} is not a project in KAI. Open it in KAI once, then run the command again.` };
  }
  const conversationId = await ports.createConversation(project.id, `CLI: ${job.prompt}`.slice(0, 64));
  const result = await ports.run({
    conversationId,
    prompt: job.prompt,
    agent: job.agent,
    execution: job.execution,
    route: job.route,
    autonomy: job.autonomy,
    freshSession: true,
    ...(job.model ? { model: job.model } : {}),
  });
  return {
    status: result.status === 'completed' ? 'completed' : 'failed',
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    conversationId,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
  };
}

async function writeResult(file: string, result: HeadlessResult): Promise<void> {
  await fs.writeFile(`${file}.tmp`, JSON.stringify(result), 'utf8');
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Read a job file, run it and write the result. Never throws: a job that cannot be run still gets a result file
 * saying why, so the command waiting for it does not hang.
 */
export async function processHeadlessJobFile(ports: HeadlessPorts, jobFile: string, tempDirectory: string = os.tmpdir()): Promise<void> {
  let resultFile: string | null = null;
  try {
    if (!isOwnTempFile(jobFile, JOB_PREFIX, tempDirectory)) throw new Error('The job file must be one made by the kai command.');
    const raw = JSON.parse(await fs.readFile(jobFile, 'utf8')) as { resultFile?: unknown };
    if (typeof raw.resultFile === 'string' && isOwnTempFile(raw.resultFile, RESULT_PREFIX, tempDirectory)) resultFile = raw.resultFile;
    const job = headlessJobSchema.parse(raw);
    if (!resultFile) throw new Error('The result file must be one made by the kai command.');
    await writeResult(resultFile, await runHeadlessJob(ports, job));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? `The job was not valid: ${error.issues[0]?.path.join('.') || 'job'} ${error.issues[0]?.message ?? ''}`.trim()
      : error instanceof Error ? error.message : String(error);
    if (resultFile) await writeResult(resultFile, { status: 'failed', output: '', error: message }).catch(() => undefined);
  } finally {
    await fs.rm(jobFile, { force: true }).catch(() => undefined);
  }
}
