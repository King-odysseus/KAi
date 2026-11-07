/**
 * The composer's role selectors and the recipes inside each one.
 *
 * A selector is a job, not a topic: it decides what the agent is allowed to touch and how it knows the work is
 * finished. A recipe is a specialist inside that job, and carries the skill (the instruction booklet) it loads. This
 * is why there are nine doors and not thirty: most of the ideas are recipes or skills inside one of these.
 */

export type TaskIntent =
  | 'ask'
  | 'plan'
  | 'build'
  | 'review'
  | 'test'
  | 'audit'
  | 'operate'
  | 'learn'
  | 'equalizer'
  | 'auto';

export interface PersonaRecipe {
  id: string;
  label: string;
  /** One line for the composer's recipe row. */
  description: string;
  /** Skills this recipe loads. Names must match `.agents/skills/<name>`. */
  skills: readonly string[];
  /** What is placed in the composer when the recipe is chosen. */
  starter: string;
}

export interface Persona {
  id: TaskIntent;
  label: string;
  description: string;
  placeholder: string;
  /** The default text placed in the composer when the selector is chosen. */
  starter: string;
  /** Selectors whose work runs through Auto's loop until the agent says it is done. */
  autoLike: boolean;
  /** Recipes for this selector. The first one is the default. */
  recipes?: readonly PersonaRecipe[];
}

const PLAN_STARTER = 'Plan this work. Inspect the project first. Do not change files. Explain the approach, affected areas, risks, and how you would verify it:\n\n';
const BUILD_STARTER = 'Build this safely. First state the plan, then make the smallest useful change and run relevant checks:\n\n';
const REVIEW_STARTER = 'Review this for correctness, architecture, security, and missing tests. Do not change files unless I ask:\n\n';

export const PERSONAS: readonly Persona[] = [
  {
    id: 'ask',
    label: 'General',
    description: 'Ask a question or describe a task in your own words',
    placeholder: 'Ask KAI about this project or describe a task',
    starter: '',
    autoLike: false,
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Understand first; change nothing',
    placeholder: 'Describe the outcome you want to plan',
    starter: PLAN_STARTER,
    autoLike: false,
    recipes: [
      {
        id: 'plan',
        label: 'Plan',
        description: 'Inspect first and explain the approach, risks and verification',
        skills: ['project-recon'],
        starter: PLAN_STARTER,
      },
      {
        id: 'map',
        label: 'Map project',
        description: 'Entry points, data flow, trust boundaries, real commands and risky files',
        skills: ['project-recon'],
        starter: 'Map this project: its entry points, data flow, trust boundaries, the real build/run/test commands, and the riskiest files. Do not change anything. Finish with a write_report (kind: plan) and a short summary:\n\n',
      },
      {
        id: 'threat-model',
        label: 'Threat model',
        description: 'Assets, actors, trust boundaries, abuse cases and mitigations',
        skills: ['project-recon'],
        starter: 'Threat-model this feature: the assets, the actors, the trust boundaries, the abuse cases, and the mitigation each one needs. Do not change files. Finish with a write_report (kind: plan):\n\n',
      },
      {
        id: 'scope',
        label: 'Scope check',
        description: 'What is in, what is out, the risk, and what to cut first',
        skills: ['project-recon'],
        starter: 'Check the scope of this work: what is in, what is out, the main risks, roughly how long it takes, and what to cut first if it has to shrink. Do not change files. Finish with a write_report (kind: plan):\n\n',
      },
      {
        id: 'spike',
        label: 'Spike',
        description: 'A throwaway prototype on a branch to answer one question',
        skills: ['spike-runner'],
        starter: 'Spike this. Name the one question, build the least that answers it on a spike branch, and report what you learned. Do not touch the main branch:\n\n',
      },
      {
        id: 'breakdown',
        label: 'Break down',
        description: 'A goal into small ordered tasks with checkable acceptance',
        skills: ['task-breaker'],
        starter: 'Break this goal into small, ordered tasks. Give each one acceptance criteria that can be checked, mark dependencies and the riskiest task, and list open questions. Do not change files. Finish with a write_report (kind: plan):\n\n',
      },
      {
        id: 'decision',
        label: 'Decision record',
        description: 'Compare the real options and record why one was chosen',
        skills: ['decision-recorder'],
        starter: 'Write a decision record for this. Compare the real options against this project\'s constraints, recommend one, and record the reasons and what would make us revisit it:\n\n',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Make a safe, verified change',
    placeholder: 'Describe what you want KAI to build',
    starter: BUILD_STARTER,
    autoLike: false,
    recipes: [
      {
        id: 'feature',
        label: 'Feature',
        description: 'The smallest useful change, with checks',
        skills: [],
        starter: BUILD_STARTER,
      },
      {
        id: 'bugfix',
        label: 'Fix from a report',
        description: 'Reproduce it, pin it with a failing test, then fix the cause',
        skills: ['bug-fixer'],
        starter: 'Fix this bug. Reproduce it first, write a test that fails for the reported reason, find the cause, make the smallest fix, and show the test passing:\n\n',
      },
      {
        id: 'tdd',
        label: 'Test-first',
        description: 'Red, green, refactor in small verified steps',
        skills: ['tdd-loop'],
        starter: 'Build this test-first. List the smallest behaviours in order, and for each one show the test failing before the code that makes it pass:\n\n',
      },
      {
        id: 'spec',
        label: 'From a spec',
        description: 'Build exactly what the requirements say and check each one',
        skills: ['spec-implementer'],
        starter: 'Implement this spec. List each requirement, build them one at a time with evidence, and tell me about any gap or conflict instead of choosing silently:\n\n',
      },
      {
        id: 'port',
        label: 'Port or translate',
        description: 'Move code between languages or frameworks with identical behaviour',
        skills: ['porter'],
        starter: 'Port this. Capture the current behaviour in tests first, port one unit at a time, and keep the original until the port is proven:\n\n',
      },
      {
        id: 'deadcode',
        label: 'Remove dead code',
        description: 'Prove code is unused, then remove it in small checked steps',
        skills: ['dead-code-remover'],
        starter: 'Find and remove dead code. Prove each piece is unused, including dynamic uses, remove it in small steps, and run the checks after each step:\n\n',
      },
      {
        id: 'mockup',
        label: 'Mockup to code',
        description: 'Build a screen from a design, then compare it in a real browser',
        skills: ['mockup-builder'],
        starter: 'Build this screen from the design using the project\'s own components and tokens. Then open it in a browser, compare it with the design, and fix the differences:\n\n',
      },
      {
        id: 'refactor',
        label: 'Refactor',
        description: 'Behaviour-preserving cleanup, gated on tests',
        skills: ['refactorer'],
        starter: 'Refactor this safely. Behaviour must not change. Make the smallest useful diff and run the checks; stop and tell me if the tests are red or missing:\n\n',
      },
      {
        id: 'migration',
        label: 'Migration',
        description: 'Forward and rollback, dry-run on a copy',
        skills: ['migration-author', 'safe-schema-change'],
        starter: 'Write this migration with a forward and a rollback path. Take a checkpoint and dry-run it on a copy before touching real data:\n\n',
      },
      {
        id: 'ci-fix',
        label: 'Fix CI',
        description: 'Reproduce the failing job and fix the cause',
        skills: ['ci-fixer'],
        starter: 'Fix this CI failure. Reproduce the failing job locally, find the cause, make the smallest fix, and rerun until it is green:\n\n',
      },
      {
        id: 'upgrade',
        label: 'Upgrade dependency',
        description: 'One package at a time, revert on failure',
        skills: ['dependency-upgrader'],
        starter: 'Upgrade this dependency one package at a time. Run the checks after each step and revert anything that fails:\n\n',
      },
      {
        id: 'upgrade-batch',
        label: 'Batch dependency update',
        description: 'Several packages in one pass, each tested, revert what fails',
        skills: ['dependency-upgrader'],
        starter: 'Update the outdated dependencies in one pass. Group them by risk, update each group, run the checks after every group, and revert what fails:\n\n',
      },
      {
        id: 'fixtures',
        label: 'Add fixtures',
        description: 'Realistic test data with no real personal data',
        skills: ['fixture-builder'],
        starter: 'Add realistic test fixtures for this area, with no real personal data and a reset path:\n\n',
      },
      {
        id: 'docs',
        label: 'Write docs',
        description: 'Document only what actually works',
        skills: ['docs-checker'],
        starter: 'Write or update the docs for this area from behaviour that actually works. Verify every command and env var before you write it down:\n\n',
      },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Read and judge; change nothing',
    placeholder: 'Paste or describe what you want reviewed',
    starter: REVIEW_STARTER,
    autoLike: false,
    recipes: [
      {
        id: 'code',
        label: 'Code',
        description: 'Correctness, architecture, security and missing tests',
        skills: [],
        starter: REVIEW_STARTER,
      },
      {
        id: 'branch',
        label: 'Branch vs main',
        description: 'Review the diff against the base, ranked by what blocks a merge',
        skills: ['branch-reviewer'],
        starter: 'Review this branch against its base. Read the diff in context, run the project check, and rank what must be fixed before merging. Do not change files. Finish with a write_report (kind: review):\n\n',
      },
      {
        id: 'selfreview',
        label: 'Before commit',
        description: 'Read your uncommitted changes like a reviewer and say if they are ready',
        skills: ['self-reviewer', 'commit-pr-writer'],
        starter: 'Review my uncommitted changes before I commit. Flag leftovers and unrelated changes, run the check, say if it is ready, and draft a commit message in this project\'s style. Do not change files:\n\n',
      },
      {
        id: 'explain',
        label: 'Explain this code',
        description: 'Walk through how it works, with files and lines',
        skills: ['code-explainer'],
        starter: 'Explain how this works. Start with what it does and why, then walk the path in the order it runs with file and line references. Do not change files:\n\n',
      },
      {
        id: 'conventions',
        label: 'Conventions check',
        description: 'Compare a change with the habits this project actually follows',
        skills: ['conventions-enforcer'],
        starter: 'Check this change against this project\'s conventions, both written and in the existing code. Cite an example file for each difference. Do not change files. Finish with a write_report (kind: review):\n\n',
      },
      {
        id: 'api',
        label: 'API contract',
        description: 'Routes against the schema, shapes, leftovers',
        skills: ['api-contract-verifier'],
        starter: 'Verify the API contract: every route against its spec or schema, the request and response shapes, and any undocumented or deprecated endpoint. Do not change files. Finish with a write_report (kind: review):\n\n',
      },
      {
        id: 'docs-drift',
        label: 'Docs drift',
        description: 'Setup commands, env vars and ports that are no longer true',
        skills: ['docs-checker'],
        starter: 'Check the docs against reality: every setup command, env var and port. Do not change files. Finish with a write_report (kind: review):\n\n',
      },
      {
        id: 'i18n',
        label: 'Localization',
        description: 'Hardcoded strings, missing keys, RTL and formats',
        skills: ['localization-checker'],
        starter: 'Check localization: hardcoded strings, missing keys, RTL, and date, number and currency formats. Do not change files. Finish with a write_report (kind: review):\n\n',
      },
    ],
  },
  {
    id: 'test',
    label: 'Test',
    description: 'Run the checks, or write the missing tests',
    placeholder: 'What should be tested, or which failure to chase?',
    starter: 'Verify this change. Find the project\'s real test command, run it, and report what is broken with the exact output. Do not fix anything:\n\n',
    autoLike: true,
    recipes: [
      {
        id: 'run',
        label: 'Run & triage',
        description: 'Run the real tests and explain each failure',
        skills: ['test-runner'],
        starter: 'Verify this change. Find the project\'s real test command, run it, and report what is broken with the exact output. Do not fix anything:\n\n',
      },
      {
        id: 'write',
        label: 'Write tests',
        description: 'Add the missing tests and run them',
        skills: ['test-author'],
        starter: 'Write the missing tests for this change, run them, and report the pass/fail result. Only test files may change:\n\n',
      },
      {
        id: 'browser',
        label: 'Browser flow check',
        description: 'Run the app locally and click through a real flow',
        skills: ['browser-verifier'],
        starter: 'Check this in the browser. Start the app on localhost, click through the flow with Playwright, and report each step with a screenshot and any console errors. Do not change product code:\n\n',
      },
      {
        id: 'repro',
        label: 'Reproduce from a log',
        description: 'Turn an error report into a minimal failing case',
        skills: ['bug-reproducer'],
        starter: 'Reproduce this from the report. Build the smallest case that fails on demand and show the exact failing output. Do not fix the bug:\n\n',
      },
      {
        id: 'edgecases',
        label: 'Edge-case hunt',
        description: 'Try unusual inputs against the real code and report what breaks',
        skills: ['edge-case-hunter'],
        starter: 'Try to break this. List its assumptions, test inputs that violate each one against the real code, and report what fails, with the exact input and output. Do not change product code:\n\n',
      },
      {
        id: 'coverage',
        label: 'Coverage gaps',
        description: 'Untested paths, ranked by risk',
        skills: ['test-runner'],
        starter: 'Map the untested paths in this change and rank them by risk. Do not write tests yet. Finish with a write_report (kind: test):\n\n',
      },
      {
        id: 'regression',
        label: 'Find the break',
        description: 'Reproduce the bug and bisect the commits',
        skills: ['test-runner'],
        starter: 'Find when this broke. Reproduce the bug, bisect the commits, and name the change that introduced it. Do not fix anything:\n\n',
      },
      {
        id: 'flaky',
        label: 'Fix flaky test',
        description: 'Reproduce the race and prove the fix',
        skills: ['test-author'],
        starter: 'Make this flaky test reliable. Reproduce the race, fix the test or the code, and prove it with repeated runs:\n\n',
      },
    ],
  },
  {
    id: 'audit',
    label: 'Audit',
    description: 'Adversarial, read-only sweep of your own project',
    placeholder: 'What should be audited? Leave blank for the whole project',
    starter: 'Act as the $security-auditor skill. Attack ',
    autoLike: true,
    recipes: [
      {
        id: 'security',
        label: 'Security',
        description: 'Injection, auth, secrets, paths, SSRF and dependencies',
        skills: ['security-auditor'],
        starter: 'Act as the $security-auditor skill. Attack ',
      },
      {
        id: 'secrets',
        label: 'Secrets and injection',
        description: 'Leaked secrets and unsafe handling of input',
        skills: ['secrets-injection-check'],
        starter: 'Check for committed secrets and injection. Look in the files and the history, trace untrusted input to every sink, and report each finding with its file and line. Do not change files. Finish with a write_report (kind: audit):\n\n',
      },
      {
        id: 'accessibility',
        label: 'Accessibility',
        description: 'Keyboard paths, labels, focus, contrast and zoom',
        skills: ['accessibility-auditor'],
        starter: 'Act as the $accessibility-auditor skill. Audit ',
      },
      {
        id: 'performance',
        label: 'Performance',
        description: 'Measure bundle, startup, queries and render time first',
        skills: ['performance-profiler'],
        starter: 'Act as the $performance-profiler skill. Profile ',
      },
      {
        id: 'privacy',
        label: 'Privacy',
        description: 'PII flow, logs, retention, third-party sends and deletion',
        skills: ['privacy-auditor'],
        starter: 'Act as the $privacy-auditor skill. Audit ',
      },
      {
        id: 'reliability',
        label: 'Reliability',
        description: 'Silent failures, timeouts, retries, leaks and health',
        skills: ['reliability-auditor'],
        starter: 'Act as the $reliability-auditor skill. Audit ',
      },
      {
        id: 'dependencies',
        label: 'Dependencies',
        description: 'Advisories, reachability, install scripts and licences',
        skills: ['dependency-auditor'],
        starter: 'Act as the $dependency-auditor skill. Audit ',
      },
      {
        id: 'licences',
        label: 'Licences',
        description: 'Licences, attribution and copied code, to avoid unlicensed use',
        skills: ['license-attribution-checker'],
        starter: 'Act as the $license-attribution-checker skill. Check ',
      },
      {
        id: 'compliance',
        label: 'Legal compliance',
        description: 'Laws and data rules of each country the app is distributed in',
        skills: ['legal-compliance-checker'],
        starter: 'Act as the $legal-compliance-checker skill. Check compliance for distributing in ',
      },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    description: 'Prepare a release or fix production; asks before acting',
    placeholder: 'What should be released, preflighted or fixed?',
    starter: 'Prepare this release. Read the changes, write the release notes, and list the exact steps. Do not push or deploy without asking:\n\n',
    autoLike: true,
    recipes: [
      {
        id: 'release',
        label: 'Release',
        description: 'Version, changelog, tag and package; push only when asked',
        skills: ['release-manager'],
        starter: 'Prepare this release. Read the changes, write the release notes, and list the exact steps. Do not push or deploy without asking:\n\n',
      },
      {
        id: 'changelog',
        label: 'Changelog',
        description: 'Release notes from the history since the last release',
        skills: ['changelog-writer'],
        starter: 'Write the release notes since the last release. Group the changes by what they mean for the user, call out anything that breaks, and match the existing changelog\'s style. Do not tag or publish:\n\n',
      },
      {
        id: 'branches',
        label: 'Clean up branches',
        description: 'List stale branches and worktrees, then remove only what you approve',
        skills: ['branch-cleaner'],
        starter: 'List the stale local branches and worktrees with the reason for each. Do not delete anything until I approve the names:\n\n',
      },
      {
        id: 'postmortem',
        label: 'Postmortem',
        description: 'A blameless write-up with a sourced timeline and actions',
        skills: ['postmortem-writer'],
        starter: 'Write a blameless postmortem for this. Build the timeline from real evidence with a source for each entry, and separate confirmed causes from likely ones:\n\n',
      },
      {
        id: 'preflight',
        label: 'Deploy preflight',
        description: 'Env, secrets, migrations, health and rollback',
        skills: ['deploy-preflight'],
        starter: 'Preflight this deploy: env vars, secrets, migrations, the health endpoint, the rollback plan, and config drift since the last release. Do not deploy:\n\n',
      },
      {
        id: 'incident',
        label: 'Incident',
        description: 'Diagnose, smallest fix, short postmortem',
        skills: ['incident-responder'],
        starter: 'Diagnose this incident from the crash records and recent changes, apply the smallest safe fix, and write a short postmortem:\n\n',
      },
      {
        id: 'data-migration',
        label: 'Data migration',
        description: 'Dry run, backup, rollback and an approval step',
        skills: ['data-migrator'],
        starter: 'Plan this data migration with a dry run, a backup, a rollback script, and an explicit approval step before anything irreversible:\n\n',
      },
    ],
  },
  {
    id: 'learn',
    label: 'Learn',
    description: 'Understand architecture or security',
    placeholder: 'What do you want to understand?',
    starter: 'Teach me this in simple terms. Focus on the architecture, security implications, trade-offs, and one small way I can check my understanding:\n\n',
    autoLike: false,
  },
  {
    id: 'equalizer',
    label: 'Equalizer',
    description: 'Compare the built screens with their design and report every difference',
    placeholder: 'Say what does not match, for example: the dashboard on my dev server',
    starter: '',
    autoLike: false,
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Send the task and KAI works it on its own until the agent says it is done',
    placeholder: 'Describe the task; send it and Auto works it until it is done',
    starter: '',
    autoLike: true,
  },
];

/**
 * The intent a stored value names, or General when it names nothing KAI still offers.
 *
 * Storage outlives the code that wrote it: an intent renamed or removed would otherwise leave the composer showing
 * a mode that no longer exists, so anything unrecognised falls back rather than being trusted.
 */
export function savedTaskIntent(stored: string | null): TaskIntent {
  // `security-auditor` was this selector's old id, before the Audit umbrella.
  if (stored === 'security-auditor') return 'audit';
  return PERSONAS.some((persona) => persona.id === stored) ? stored as TaskIntent : 'ask';
}

export function personaFor(intent: TaskIntent): Persona {
  return PERSONAS.find((persona) => persona.id === intent) ?? PERSONAS[0]!;
}

/** The recipe a selector starts on: its first, or none for selectors with no recipes. */
/** A recipe saved from a run, in the shape this file needs. Kept structural so this file stays free of the schema. */
export interface SavedRecipeLike {
  id: string;
  intent: string;
  label: string;
  description: string;
  starter: string;
  skills: readonly string[];
}

/**
 * The recipes to offer inside a selector: the built-in ones, then the person's own saved for that selector. A saved
 * one never replaces a built-in, and the first recipe (the default) stays the built-in's.
 */
export function recipesFor(persona: Persona, saved: readonly SavedRecipeLike[] = []): readonly PersonaRecipe[] {
  const own = saved
    .filter((recipe) => recipe.intent === persona.id)
    .map((recipe) => ({ id: recipe.id, label: recipe.label, description: recipe.description, skills: recipe.skills, starter: recipe.starter }));
  const builtIn = persona.recipes ?? [];
  return own.length === 0 ? builtIn : [...builtIn, ...own];
}

export function defaultRecipe(persona: Persona): PersonaRecipe | undefined {
  return persona.recipes?.[0];
}

export type AutoLikeIntent = 'auto' | 'test' | 'audit' | 'operate';

/**
 * A type guard, so callers can narrow the composer's intent to the ones Auto can run. The table is the source of
 * truth; the union above is what the table currently says, and `desktop-personas.test.ts` pins them together.
 */
export function isAutoLikeIntent(intent: TaskIntent): intent is AutoLikeIntent {
  return personaFor(intent).autoLike;
}

/** Every starter the composer may have put there itself, so switching a recipe does not overwrite typed text. */
export function isKnownStarter(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return PERSONAS.some((persona) => persona.starter.trim() === trimmed
    || persona.recipes?.some((recipe) => recipe.starter.trim() === trimmed));
}
