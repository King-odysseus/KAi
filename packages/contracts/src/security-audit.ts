import { z } from 'zod';
import {
  securityFindingSchema,
  securityFindingSeveritySchema,
  securityFindingStatusSchema,
  type SecurityFinding,
} from './security-findings';

/**
 * The audit recipes the Security Auditor offers, and the prompt each one becomes.
 *
 * They are product copy rather than model instructions kept somewhere else on purpose: the panel shows the same
 * words it sends, and a saved prompt in the composer is the exact text the panel would have run. Every recipe
 * shares the same boundaries and the same report contract, so a new one cannot quietly drop the local-only rule.
 */

export const securityScanProfileSchema = z.enum([
  'full',
  'changed',
  'injection',
  'auth',
  'secrets',
  'dependencies',
  'uploads',
  'api',
  'verify',
]);
export type SecurityScanProfile = z.infer<typeof securityScanProfileSchema>;

export interface SecurityScanRecipe {
  id: Exclude<SecurityScanProfile, 'verify'>;
  label: string;
  /** One line for the picker. */
  description: string;
  /** What the target box means for this recipe. */
  targetHint: string;
  /** The task-specific part of the prompt; the shared rules are added by `securityAuditPrompt`. */
  instructions: string;
}

export const SECURITY_SCAN_RECIPES: readonly SecurityScanRecipe[] = [
  {
    id: 'full',
    label: 'Whole project',
    description: 'Dependencies, secrets, injection, auth, paths, uploads, SSRF and headers',
    targetHint: 'A file, folder or feature — leave blank for the whole project',
    instructions:
      'Attack the whole project. Start with the dependency audit and a secret scan, because those are cheap and factual, then review injection, auth and session handling, path traversal, SSRF, unsafe deserialization, file uploads, and CORS/security-header configuration. Prefer the changed and entry-point files over generated code, vendored code and tests.',
  },
  {
    id: 'changed',
    label: 'Changed files',
    description: 'Only what changed since the last commit, plus its direct callers',
    targetHint: 'Leave blank to use the working tree diff',
    instructions:
      'Attack only the files changed since the last commit, plus their direct callers. Find them with `git diff --name-only` and `git diff`, and read the changed hunks before the rest of each file. For every change, ask what attacker-controlled input reaches it and what check is missing. Ignore unrelated code even when it looks suspicious.',
  },
  {
    id: 'injection',
    label: 'Injection',
    description: 'SQL, command, template, NoSQL, LDAP and unsafe eval',
    targetHint: 'A request handler, query builder or feature',
    instructions:
      'Attack injection only: SQL, command, template/SSTI, NoSQL, LDAP, and unsafe `eval`/`Function`/child-process calls built from user input. Trace every request parameter, query string, form field, filename and header to its sink. Prove each finding with the smallest safe payload and show the exact input and the response it produced.',
  },
  {
    id: 'auth',
    label: 'Auth & access',
    description: 'Sessions, password reset, IDOR and privilege escalation',
    targetHint: 'A route, middleware or account feature',
    instructions:
      'Attack authentication and authorization only. Check login, session creation and expiry, logout, password reset, remember-me, and every route for a missing authorization check. Try horizontal access (another user\'s resource id), vertical access (an admin route as a normal user), token replay and session fixation — against a local test account you create for this purpose, never a real account or live credentials.',
  },
  {
    id: 'secrets',
    label: 'Secrets & config',
    description: 'Committed keys, .env files, logs and build output',
    targetHint: 'A folder, or leave blank for the whole project and its history',
    instructions:
      'Attack secrets and configuration only. Scan the working tree and the git history for committed keys, tokens, passwords, `.env` files, private keys, and secrets written to logs or build output. Check that local development secrets cannot ship in a build and that `.gitignore` covers every secret file. Report where the secret is, roughly how long it has been exposed, and the rotation step. Never print a secret value: show a redacted prefix only.',
  },
  {
    id: 'dependencies',
    label: 'Dependencies',
    description: 'Advisories, install scripts and version ranges',
    targetHint: 'Leave blank to audit the project manifests and lockfile',
    instructions:
      'Attack the dependency supply chain only. Run `npm audit --json`, read the lockfile, and look for install scripts, unmaintained packages, and version ranges that float to unknown majors. For every advisory, say whether the vulnerable code path is actually reachable from this application. Keep "reachable" separate from "present but unused". Do not install, upgrade or pin anything without being asked; propose the smallest change instead.',
  },
  {
    id: 'uploads',
    label: 'Uploads & paths',
    description: 'Traversal, symlinks, zip-slip, MIME and static serving',
    targetHint: 'An upload endpoint or file-serving path',
    instructions:
      'Attack file handling only. Test upload endpoints and every filesystem read or write where a name or path comes from the user: `../` traversal, absolute paths, symlinks, zip-slip, extension and MIME mismatches, oversized files, and static-file serving that escapes the web root. Reproduce locally with harmless files, and use a payload whose only effect is to read or list. No destructive payloads.',
  },
  {
    id: 'api',
    label: 'API & network',
    description: 'Missing auth, CSRF, CORS, headers, throttling and SSRF',
    targetHint: 'An API route, server action or fetch helper',
    instructions:
      'Attack the API surface only. Check every route for a missing auth check, CSRF protection, permissive CORS, missing security headers, unthrottled endpoints, and SSRF in any server-side URL fetch. For SSRF, prove it only against a local listener you start yourself — never an external host, and never a deployed URL. Show the request that demonstrates the issue.',
  },
];

export const securityScanInputSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    profile: securityScanProfileSchema.default('full'),
    target: z.string().trim().max(500).default(''),
    /** Set for a verify pass: the finding being re-tested. */
    findingId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SecurityScanInput = z.infer<typeof securityScanInputSchema>;

export const securityScanResultSchema = z
  .object({
    conversationId: z.string().min(1),
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    error: z.string().optional(),
    /** The whole log after the pass, so the panel does not need a second call. */
    findings: z.array(securityFindingSchema),
  })
  .strict();
export type SecurityScanResult = z.infer<typeof securityScanResultSchema>;

export interface SecurityAuditPromptOptions {
  profile: SecurityScanProfile;
  /** A file, folder, feature or route. Blank means the whole project. */
  target?: string;
  projectName?: string;
  /** The finding a verify pass is re-testing. */
  finding?: SecurityFinding;
  /** Facts a deterministic pass already found, so the agent verifies them instead of guessing. */
  prepass?: string;
}

/**
 * The one prompt every audit runs from. The shared half states the boundary and the report contract, so a recipe
 * only has to describe what to attack.
 */
export function securityAuditPrompt(options: SecurityAuditPromptOptions): string {
  const target = options.target?.trim() ?? '';
  const scope = target
    ? `Target: ${target}`
    : options.projectName
      ? `Target: the whole project (${options.projectName})`
      : 'Target: the whole project';
  const recipe = SECURITY_SCAN_RECIPES.find((entry) => entry.id === options.profile);
  const task = options.profile === 'verify' ? verifyInstructions(options.finding) : recipe?.instructions ?? SECURITY_SCAN_RECIPES[0]!.instructions;
  const reportStatus = options.profile === 'verify'
    ? 'Each object must carry `status`: "fixed" if the original reproduction no longer works, "open" if it still does.'
    : 'Do not include `status`; a finding is open unless the person says otherwise.';

  return [
    // `$name` is the composer's skill mention: a saved copy of this prompt selects the skill when it is sent, even
    // if the person did not pick the Security Auditor intent.
    'Act as the $security-auditor skill.',
    task,
    scope,
    ...(options.prepass?.trim() ? ['', options.prepass.trim()] : []),
    '',
    'Hard boundary: local only. The only valid target is this project\'s own source tree and, for a dynamic pass, a dev server you start yourself on localhost or 127.0.0.1. Never a deployed URL, staging host, Railway hostname or anything the person did not start locally. If a step would need a non-local host, stop and say so rather than proceeding. No rate-limit evasion, no credential stuffing, no destructive payloads; prove a vulnerability with the smallest safe payload.',
    '',
    'Rules for every finding:',
    '- Reproduce it before reporting it. If it can only be shown by reading the code, say `static-only` in the evidence and explain the path; do not call it confirmed.',
    '- Evidence is the exact input, request or code path and the exact unexpected result — enough for someone else to reproduce it in one step. Never include a real secret or live credential; redact it.',
    '- The concept card teaches the bug class: what it is, why this instance is exploitable, and the general fix pattern. Write it for a learner, not just a fixer.',
    '- Severity: critical when it leads to remote code execution, full account takeover or unauthenticated data access; high for authenticated escalation or meaningful data exposure; medium for an issue that needs a precondition; low for hardening; info only when it is a real observation with no security impact. Do not pad the report with info findings.',
    '- Do not fix anything in this pass unless the person explicitly asked. Found and fixed are separate so both can be reviewed.',
    '',
    options.profile === 'verify'
      ? 'Call `save_security_finding` with the finding id so the existing record is updated, not duplicated.'
      : 'Call the `save_security_finding` tool once for each finding, if it is available. It writes the same record the report block below carries, so a run without the tool still files its findings.',
    '',
    'End your reply with exactly one fenced block in this shape, and nothing after it:',
    '```json kai-security-findings',
    '[{"severity":"high","vulnClass":"sql-injection","title":"Search endpoint concatenates raw input into SQL","location":"src/api/search.ts:18","evidence":"GET /api/search?q=\' OR \'1\'=\'1 returned all rows instead of zero matches.","conceptCard":"SQL injection: user input reaches the query as text instead of as a bound value. Fix by passing it as a parameter."}]',
    '```',
    reportStatus,
    'An empty array is the right answer when nothing was reproduced; say plainly that nothing was found rather than inventing a low-severity issue.',
  ].join('\n');
}

function verifyInstructions(finding: SecurityFinding | undefined): string {
  if (!finding) {
    return 'Re-test one existing finding. No finding details were supplied, so do not scan anything else: say that the finding could not be loaded.';
  }
  return [
    `Re-test one existing finding only: ${finding.title} (${finding.vulnClass} at ${finding.location}).`,
    `The recorded evidence was: ${finding.evidence}`,
    'Re-run that exact reproduction, and inspect the current code for the check the finding said was missing. Do not scan anything else and do not change project files.',
    'Report one object for this finding: "fixed" when the original reproduction no longer works and the missing check is present, "open" when it still reproduces or the check is still missing, "wont-fix" only when the person already decided that. If you cannot reproduce either state, return an empty array and explain why.',
  ].join(' ');
}

/**
 * The item an agent puts in the report block. Kept separate from the saved record because the report is a claim
 * the main process verifies and stores; it may carry a status a normal save would not.
 */
export const securityFindingReportItemSchema = z
  .object({
    severity: securityFindingSeveritySchema,
    vulnClass: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
    location: z.string().trim().min(1).max(500),
    evidence: z.string().trim().min(1).max(4_000),
    conceptCard: z.string().trim().min(1).max(4_000),
    status: securityFindingStatusSchema.optional(),
    /** Set by a verify pass so an id-addressed update is possible even if the title was reworded. */
    findingId: z.string().min(1).max(200).optional(),
  })
  // Unknown keys are stripped rather than refused: models add a field or two to these blocks, and losing a whole
  // real finding over an extra key would be the wrong trade.
  .strip();
export type SecurityFindingReportItem = z.infer<typeof securityFindingReportItemSchema>;

/**
 * Reads the report block from a finished run. The last block wins — a run that showed a corrected block earlier
 * and restated it at the end meant the final one. A malformed block yields nothing rather than throwing: the run
 * itself still happened, and the panel should show its output rather than a parse error.
 */
export function parseSecurityFindingsReport(output: string): SecurityFindingReportItem[] {
  const blocks = [...output.matchAll(/```(?:json)?[ \t]*kai-security-findings[ \t]*\r?\n([\s\S]*?)```/gi)];
  const last = blocks.at(-1)?.[1];
  if (!last) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.trim());
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : [];
  const findings: SecurityFindingReportItem[] = [];
  for (const item of items) {
    const result = securityFindingReportItemSchema.safeParse(item);
    if (result.success) findings.push(result.data);
  }
  return findings;
}
