import { z } from 'zod';

export const verificationRunSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    // When a check was run as part of a conversation goal, preserve that link so evidence can be reviewed with the task.
    taskId: z.string().min(1).max(120).optional(),
    taskOutcome: z.string().min(1).max(4_000).optional(),
    command: z.string().min(1).max(2_000),
    source: z.enum(['user', 'agent']),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    unverifiedReason: z.string().optional(),
    startedAt: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    // Git HEAD when the check ran, so a later commit is visible in the history.
    head: z.string().nullable(),
    // Content hashes of every changed file at the moment the check finished.
    files: z.array(z.object({ path: z.string().min(1), hash: z.string().min(1) }).strict()),
    testsPassed: z.number().int().nonnegative().nullable(),
    testsFailed: z.number().int().nonnegative().nullable(),
    outputTail: z.string(),
  })
  .strict()
  .transform((run) => {
    const reason = run.unverifiedReason ?? verificationCaveat(run.command, run.outputTail);
    return reason ? { ...run, passed: false, unverifiedReason: reason } : run;
  });

export const verificationFileStatusSchema = z
  .object({ path: z.string().min(1), status: z.enum(['verified', 'failed', 'stale', 'unverified']) })
  .strict();

export const verificationOverviewSchema = z
  .object({
    // Best guess at the project's test command (npm test, pytest, ...), or null when unknown.
    suggestedCommand: z.string().nullable(),
    gitAvailable: z.boolean(),
    latest: verificationRunSchema.nullable(),
    files: z.array(verificationFileStatusSchema),
    history: z.array(verificationRunSchema),
  })
  .strict();

export const verificationRunInputSchema = z
  .object({ projectId: z.string().min(1), command: z.string().trim().min(1).max(2_000) })
  .strict();

export type VerificationRun = z.infer<typeof verificationRunSchema>;
export type VerificationFileStatus = z.infer<typeof verificationFileStatusSchema>;
export type VerificationOverview = z.infer<typeof verificationOverviewSchema>;
export type FileVerificationState = VerificationFileStatus['status'];

const TEST_COMMAND = /\b(npm\s+(run\s+)?(test|lint|typecheck|check)|pnpm\s+(run\s+)?(test|lint|typecheck)|yarn\s+(run\s+)?(test|lint|typecheck)|vitest|jest|mocha|pytest|python\s+-m\s+(pytest|unittest)|cargo\s+(test|check|clippy)|go\s+(test|vet)|dotnet\s+test|mvn\s+(test|verify)|gradle\s+test|tsc\b|eslint|ruff|mypy|phpunit|rspec)\b/i;

/** True for commands that check the code (tests, type checks, linters), as opposed to builds or installs. */
export function isVerificationCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/** Test totals from common runners' summary lines, or nulls when the output is not recognised. */
export function parseTestCounts(output: string): { passed: number | null; failed: number | null } {
  const vitest = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i.exec(output);
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0) };
  const pytest = /=+\s*(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed)?/i.exec(output);
  if (pytest && (pytest[1] || pytest[2]) && /\bin\s+[\d.]+s/i.test(output)) return { passed: Number(pytest[2] ?? 0), failed: Number(pytest[1] ?? 0) };
  const cargo = /test result: (?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/i.exec(output);
  if (cargo) return { passed: Number(cargo[1]), failed: Number(cargo[2]) };
  return { passed: null, failed: null };
}

/**
 * Status of each currently changed file against the latest check. A file is verified only when the
 * latest run passed and saw exactly this content; any other content makes it stale.
 */
export function verificationStatuses(
  latest: Pick<VerificationRun, 'passed' | 'files'> & { unverifiedReason?: string } | null,
  current: ReadonlyArray<{ path: string; hash: string }>,
): VerificationFileStatus[] {
  const seen = new Map((latest?.files ?? []).map((file) => [file.path, file.hash]));
  return current.map((file) => {
    if (!latest || latest.unverifiedReason) return { path: file.path, status: 'unverified' as const };
    const before = seen.get(file.path);
    if (before === undefined) return { path: file.path, status: 'stale' as const };
    if (before !== file.hash) return { path: file.path, status: 'stale' as const };
    return { path: file.path, status: latest.passed ? ('verified' as const) : ('failed' as const) };
  });
}

/** Explicit mock/stub evidence cannot prove project behaviour, even with exit code zero. */
export function verificationCaveat(command: string, output: string): string | undefined {
  if (/^\s*(?:mock|stub|simulated|fake)\s+(?:TypeScript\s+)?(?:tsc|compiler|typecheck|check command)\b|^\s*(?:tsc|compiler|typecheck)\s+(?:is a |is |was )?(?:mock|stub|simulated|fake)\b|^\s*this is (?:a )?(?:mock|stub)\b/im.test(output)
    || /^\s*(?:echo|printf|Write-Output)\s+.*(?:passed|success|tsc|test)/i.test(command)) {
    return 'This command reports a mock or simulated check. It does not verify the project.';
  }
  return undefined;
}

export function checkEvidenceFromEvents(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): Array<{ command: string; exitCode: number; output: string; timestamp: string }> {
  return events.flatMap((event) => {
    if (event.type !== 'tool.call' || (event.status !== 'completed' && event.status !== 'failed')) return [];
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {};
    const command = typeof input.command === 'string' ? input.command : typeof input.cmd === 'string' ? input.cmd : '';
    if (!isVerificationCommand(command)) return [];
    const output = event.output && typeof event.output === 'object' ? event.output as Record<string, unknown> : {};
    const exitCode = typeof output.exitCode === 'number' ? output.exitCode : typeof output.exit_code === 'number' ? output.exit_code : null;
    if (exitCode === null) return [];
    return [{ command, exitCode, output: [output.stdout, output.stderr, output.output].filter((part): part is string => typeof part === 'string').join('\n'), timestamp: String(event.timestamp ?? '') }];
  });
}
