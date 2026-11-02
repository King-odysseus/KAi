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
  .strict();

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
  latest: Pick<VerificationRun, 'passed' | 'files'> | null,
  current: ReadonlyArray<{ path: string; hash: string }>,
): VerificationFileStatus[] {
  const seen = new Map((latest?.files ?? []).map((file) => [file.path, file.hash]));
  return current.map((file) => {
    if (!latest) return { path: file.path, status: 'unverified' as const };
    const before = seen.get(file.path);
    if (before === undefined) return { path: file.path, status: 'stale' as const };
    if (before !== file.hash) return { path: file.path, status: 'stale' as const };
    return { path: file.path, status: latest.passed ? ('verified' as const) : ('failed' as const) };
  });
}
