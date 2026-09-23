import * as path from 'node:path';
import { z } from 'zod';
import {
  teachingDraftGenerateInputSchema,
  teachingLibrarySchema,
  teachingLibrarySaveInputSchema,
  type TeachingDraftGenerateInput,
  type TeachingLibrary,
  type TeachingLibraryEntry,
  type TeachingLibraryKind,
  type TeachingLibrarySaveInput,
} from '@kai/contracts';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

interface TeachingMetadata {
  id: string;
  kind: TeachingLibraryKind;
  title: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
}

interface DefaultTeachingEntry {
  id: string;
  kind: TeachingLibraryKind;
  title: string;
  description: string;
  content: string;
  order: number;
}

const metadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
  kind: z.enum(['method', 'rule']),
  title: z.string().min(1).max(200),
  description: z.string().max(1_000),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  order: z.number().int().min(0).max(10_000),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

const metadataStateSchema = z.object({
  schemaVersion: z.literal(1),
  methods: z.array(metadataSchema.refine((entry) => entry.kind === 'method')).max(200),
  rules: z.array(metadataSchema.refine((entry) => entry.kind === 'rule')).max(500),
  updatedAt: z.string().min(1),
}).strict();

type MetadataState = z.infer<typeof metadataStateSchema>;

const MAX_TEACHING_PROFILE_CHARS = 80_000;

export class TeachingLibraryStore {
  private readonly stateStore: AtomicJsonStore<MetadataState>;

  constructor(
    private readonly directory: string,
    private readonly fileSystem: NodeFileSystem,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.stateStore = new AtomicJsonStore({
      filePath: path.join(directory, 'library.json'),
      fileSystem,
      schema: metadataStateSchema,
      defaultValue: () => ({
        schemaVersion: 1,
        methods: [],
        rules: [],
        updatedAt: this.now().toISOString(),
      }),
    });
  }

  async get(): Promise<TeachingLibrary> {
    const state = await this.ensureState();
    const [methods, rules] = await Promise.all([
      this.readEntries('method', state.methods),
      this.readEntries('rule', state.rules),
    ]);
    return teachingLibrarySchema.parse({
      schemaVersion: 1,
      directory: this.directory,
      methods,
      rules,
      updatedAt: state.updatedAt,
    });
  }

  async profile(): Promise<string> {
    const library = await this.get();
    const methods = library.methods.filter((entry) => entry.enabled);
    const rules = library.rules.filter((entry) => entry.enabled);
    if (!methods.length && !rules.length) return 'No KAI teaching methods or rules are enabled.';
    const sections = [
      'App-owned KAI teaching library. Treat these enabled methods and rules as authoritative teaching policy unless a narrower project instruction is explicitly supplied.',
    ];
    if (methods.length) {
      sections.push([
        '# Enabled teaching methods',
        ...methods.map((entry) => `## ${entry.title}\n${entry.content.trim()}`),
      ].join('\n\n'));
    }
    if (rules.length) {
      sections.push([
        '# Enabled teaching rules',
        ...rules.map((entry) => `## ${entry.title}\n${entry.content.trim()}`),
      ].join('\n\n'));
    }
    const profile = sections.join('\n\n');
    if (profile.length <= MAX_TEACHING_PROFILE_CHARS) return profile;
    return `${profile.slice(0, MAX_TEACHING_PROFILE_CHARS)}\n\n[KAI teaching library truncated; disable unused entries or shorten the enabled Markdown.]`;
  }

  async save(input: TeachingLibrarySaveInput): Promise<TeachingLibrary> {
    const parsed = teachingLibrarySaveInputSchema.parse(input);
    const state = await this.ensureState();
    const entries = state[`${parsed.kind}s`];
    const index = entries.findIndex((entry) => entry.id === parsed.id);
    const existing = index >= 0 ? entries[index] : undefined;
    const now = this.now().toISOString();
    const metadata: TeachingMetadata = {
      id: parsed.id,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description,
      enabled: parsed.enabled,
      builtIn: existing?.builtIn ?? false,
      order: existing?.order ?? nextOrder(entries),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (index >= 0) entries[index] = metadata;
    else entries.push(metadata);
    await this.fileSystem.mkdir(path.dirname(this.entryPath(parsed.kind, parsed.id)));
    await this.fileSystem.writeText(this.entryPath(parsed.kind, parsed.id), ensureTrailingNewline(parsed.content));
    await this.saveState(state);
    return this.get();
  }

  async remove(kind: TeachingLibraryKind, id: string): Promise<TeachingLibrary> {
    const state = await this.ensureState();
    const entries = state[`${kind}s`];
    const existing = entries.find((entry) => entry.id === id);
    if (!existing) throw new Error('Teaching entry not found.');
    if (existing.builtIn) throw new Error('Built-in KAI teaching entries can be reset but not deleted.');
    state[`${kind}s`] = entries.filter((entry) => entry.id !== id);
    await this.fileSystem.remove(this.entryPath(kind, id));
    await this.saveState(state);
    return this.get();
  }

  async reset(kind: TeachingLibraryKind, id: string): Promise<TeachingLibrary> {
    const entry = defaultEntries().find((candidate) => candidate.kind === kind && candidate.id === id);
    if (!entry) throw new Error('Only built-in KAI teaching entries can be reset.');
    const state = await this.ensureState();
    const entries = state[`${kind}s`];
    const index = entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error('Teaching entry not found.');
    const current = entries[index]!;
    entries[index] = {
      ...current,
      title: entry.title,
      description: entry.description,
      enabled: true,
      order: entry.order,
      updatedAt: this.now().toISOString(),
    };
    await this.fileSystem.mkdir(path.dirname(this.entryPath(kind, id)));
    await this.fileSystem.writeText(this.entryPath(kind, id), entry.content);
    await this.saveState(state);
    return this.get();
  }

  private async ensureState(): Promise<MetadataState> {
    const state = await this.stateStore.load();
    let changed = false;
    for (const entry of defaultEntries()) {
      const entries = state[`${entry.kind}s`];
      if (!entries.some((candidate) => candidate.id === entry.id)) {
        const now = this.now().toISOString();
        entries.push({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          description: entry.description,
          enabled: true,
          builtIn: true,
          order: entry.order,
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
      }
      if (!(await this.fileSystem.exists(this.entryPath(entry.kind, entry.id)))) {
        await this.fileSystem.mkdir(path.dirname(this.entryPath(entry.kind, entry.id)));
        await this.fileSystem.writeText(this.entryPath(entry.kind, entry.id), entry.content);
      }
    }
    if (changed || !(await this.fileSystem.exists(path.join(this.directory, 'KAI-Teaching.md')))) {
      await this.saveState(state);
    }
    await this.writeReadableDocuments(state);
    return state;
  }

  private async saveState(state: MetadataState): Promise<void> {
    state.updatedAt = this.now().toISOString();
    await this.stateStore.save(state);
    await this.writeReadableDocuments(state);
  }

  private async readEntries(
    kind: TeachingLibraryKind,
    metadata: TeachingMetadata[],
  ): Promise<TeachingLibraryEntry[]> {
    const entries = await Promise.all(metadata.map(async (entry) => {
      let content: string;
      try {
        content = await this.fileSystem.readText(this.entryPath(kind, entry.id));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        const fallback = defaultEntries().find((candidate) => candidate.kind === kind && candidate.id === entry.id);
        content = fallback?.content ?? `# ${entry.title}\n\nThe Markdown file for this entry is missing. Save the entry in KAI Learning Mode to recreate it.`;
        await this.fileSystem.mkdir(path.dirname(this.entryPath(kind, entry.id)));
        await this.fileSystem.writeText(this.entryPath(kind, entry.id), ensureTrailingNewline(content));
      }
      return {
        ...entry,
        content,
      };
    }));
    return entries.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)) as TeachingLibraryEntry[];
  }

  private async writeReadableDocuments(state: MetadataState): Promise<void> {
    await this.fileSystem.mkdir(this.directory);
    const methods = state.methods.sort(compareMetadata).map((entry) => [
      `## ${entry.enabled ? '[x]' : '[ ]'} ${entry.title}`,
      '',
      entry.description || 'No description.',
      '',
      `Source: [methods/${entry.id}.md](methods/${entry.id}.md)`,
    ].join('\n'));
    const rules = state.rules.sort(compareMetadata).map((entry) => [
      `## ${entry.enabled ? '[x]' : '[ ]'} ${entry.title}`,
      '',
      entry.description || 'No description.',
      '',
      `Source: [rules/${entry.id}.md](rules/${entry.id}.md)`,
    ].join('\n'));
    await this.fileSystem.writeText(path.join(this.directory, 'KAI-Teaching.md'), [
      '# KAI Teaching Library',
      '',
      'This app-owned index is generated by KAI Desktop. Edit entries in Learning Mode > Teaching, or edit the linked Markdown source files directly.',
      '',
      '# Methods',
      '',
      ...(methods.length ? methods : ['No methods are installed.']),
      '',
      '# Rules',
      '',
      ...(rules.length ? rules : ['No teaching rules are installed.']),
      '',
    ].join('\n'));

    const ruleContents = await Promise.all(state.rules.sort(compareMetadata).map(async (entry) => {
      let content = '';
      try {
        content = await this.fileSystem.readText(this.entryPath('rule', entry.id));
      } catch {
        content = entry.description;
      }
      return `## ${entry.enabled ? '[x]' : '[ ]'} ${entry.title}\n\n${content.trim()}\n`;
    }));
    await this.fileSystem.writeText(path.join(this.directory, 'KAI-Teaching-Rules.md'), [
      '# KAI Teaching Rules',
      '',
      'Generated from the app-owned rule library. Edit rules in Learning Mode > Teaching.',
      '',
      ...(ruleContents.length ? ruleContents : ['No teaching rules are installed.']),
      '',
    ].join('\n'));
  }

  private entryPath(kind: TeachingLibraryKind, id: string): string {
    return path.join(this.directory, `${kind}s`, `${id}.md`);
  }
}

export function teachingDraftPrompt(input: TeachingDraftGenerateInput): { system: string; user: string } {
  const parsed = teachingDraftGenerateInputSchema.parse(input);
  const noun = parsed.kind === 'method' ? 'teaching method' : 'teaching rule pack';
  return {
    system: [
      'You are the KAI Teaching Library author.',
      'Return only JSON matching the provided schema.',
      `Create a reusable ${noun} for KAI Learning Mode, not a lesson about the topic.`,
      'The result must be KAI-owned, self-contained, technically accurate, and written in clear Markdown.',
      parsed.kind === 'method'
        ? 'A method must explain when to use it, the teaching sequence, how evidence is collected, and its limits.'
        : 'A rule pack must contain specific, testable rules with no vague advice.',
      'Do not mention, quote, or depend on any third-party course or a project named MoneyMatters.',
      'Do not claim that generated content has been reviewed or approved.',
      'Keep the description concise and make the content immediately editable by the learner.',
    ].join('\n'),
    user: [
      `Topic or purpose: ${parsed.topic}`,
      parsed.instructions ? `Additional requirements:\n${parsed.instructions}` : '',
      parsed.baseContent ? `Existing content to adapt:\n\n${parsed.baseContent}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

export const teachingDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'content'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    content: { type: 'string' },
  },
} as const;

function defaultEntries(): DefaultTeachingEntry[] {
  return [
    {
      id: 'kai-guided-discovery',
      kind: 'method',
      title: 'KAI Guided Discovery',
      description: 'Learner-first questioning with worked explanation only when needed.',
      order: 10,
      content: `# KAI Guided Discovery

## Use when

Use this method when the learner should build an accurate mental model before receiving a complete implementation.

## Teaching sequence

1. Recap the last confirmed idea in one or two sentences. State what changed and what the learner can already do.
2. Name the immediate learning outcome and connect it to the active file or problem.
3. Ask one diagnostic question that exposes the learner's current model.
4. Introduce a named analogy only after the concrete code has been located.
5. Map each useful analogy part to a code part. State where the analogy stops.
6. Trace the execution path from input to observable result. Explain each code line before suggesting a change.
7. Give a bounded task the learner can attempt now.
8. Check the learner's reasoning with a transfer question or a changed case.
9. Update mastery only from learner evidence, not from the quality of AI output.

## Evidence

- Prefer predictions, explanations in the learner's own words, debugging decisions, and small independent changes.
- Treat generated code, copied code, and AI-completed code as introduced material only.
- Separate a confident answer from demonstrated understanding. Ask for the reasoning behind it.

## Boundaries

- Do not invent file contents, runtime results, or learner ability.
- Do not ask a question whose answer has not been taught or discovered in the current sequence.
- Do not weaken production architecture, security, accessibility, or tests to make an exercise easier.
`,
    },
    {
      id: 'kai-worked-example-transfer',
      kind: 'method',
      title: 'KAI Worked Example to Transfer',
      description: 'Model one complete reasoning pass, then fade support and transfer the pattern.',
      order: 20,
      content: `# KAI Worked Example to Transfer

## Use when

Use this method when the learner needs a concrete model before attempting an unfamiliar pattern.

## Teaching sequence

1. Recap the previous block and state the specific skill being modelled.
2. Explain the purpose and location of the code before showing the worked example.
3. Walk through the example line by line, naming the input, transformation, state change, output, and failure path.
4. Explain the reasoning behind each meaningful choice, not only what the syntax does.
5. Summarise the reusable pattern in one sentence.
6. Fade the support: remove one part and ask the learner to reconstruct it.
7. Transfer the pattern to a nearby but non-identical case.
8. Ask the learner to compare the two cases and explain the invariant that stayed true.

## Evidence

- The learner should eventually reproduce the reasoning without the original example.
- A correct copy is not sufficient evidence. The learner must explain why it works and where it applies.

## Boundaries

- Keep the worked example complete enough to be credible.
- Do not hide a critical assumption in the example.
- If the task is too large, reduce the example rather than skipping the reasoning.
`,
    },
    {
      id: 'kai-feynman-rebuild',
      kind: 'method',
      title: 'KAI Feynman Rebuild',
      description: 'Explain, identify gaps, rebuild the idea, and verify with a working check.',
      order: 30,
      content: `# KAI Feynman Rebuild

## Use when

Use this method when the learner can recognise an idea but cannot yet explain or apply it reliably.

## Teaching sequence

1. Recap what the learner previously explained correctly.
2. Ask the learner to explain the idea to a less experienced developer without using unexplained jargon.
3. Identify the first gap, contradiction, or missing cause-and-effect link.
4. Return to the smallest concrete code path that demonstrates that link.
5. Build a named analogy for the gap, map it to code, and state its limits.
6. Ask the learner to rebuild the explanation and then rebuild the smallest working version.
7. Verify with a test, a trace, or a changed input.
8. Record only the part the learner demonstrated independently.

## Evidence

- Look for accurate cause and effect, correct vocabulary, a working reconstruction, and successful verification.
- A fluent explanation that still contains a hidden misconception is not independent mastery.

## Boundaries

- Correct the misconception directly and kindly.
- Keep the rebuilt example small enough to verify in one focused pass.
- Do not replace verification with a confidence question.
`,
    },
    {
      id: 'kai-production-investigation',
      kind: 'method',
      title: 'KAI Production Investigation',
      description: 'Learn safely from real project code by investigating evidence before editing.',
      order: 40,
      content: `# KAI Production Investigation

## Use when

Use this method when learning happens inside a real codebase and an incorrect change could affect users or shared behavior.

## Teaching sequence

1. Recap the current objective and the last verified project fact.
2. Name the exact file, symbol, or boundary being investigated.
3. Read the relevant code and tests before proposing a change.
4. Explain the execution path, ownership boundary, data contract, and failure modes.
5. Separate observations from hypotheses. Cite the file or command output that supports each observation.
6. Ask the learner to predict the effect of a small change before it is made.
7. Let the learner own lesson-related terminal commands and verification.
8. Review the diff together and explain why each changed line is necessary.
9. Record the lesson only after the learner explicitly chooses to do so.

## Evidence

- Use investigation notes, predictions, diffs, test outcomes, and the learner's explanation as evidence.
- Do not treat a passing command as mastery unless the learner can explain what it proved and what it did not prove.

## Boundaries

- Never expose secrets or private data in teaching output.
- Do not modify project files silently.
- Do not weaken a production guarantee to create a simpler teaching example.
- If the change is risky, stop at explanation and ask for approval before editing.
`,
    },
    {
      id: 'kai-core-teaching-rules',
      kind: 'rule',
      title: 'KAI Core Teaching Rules',
      description: 'The baseline rules every KAI tutoring response follows.',
      order: 10,
      content: `# KAI Core Teaching Rules

1. Start with a recap before each teaching block.
2. State the immediate purpose and connect it to the learner's current code or question.
3. Explain code in context before suggesting a change.
4. Use an analogy for difficult ideas, name its mappings, and state where it stops.
5. Explain code line by line when a block affects understanding or behaviour.
6. Keep each step small enough to attempt and verify.
7. Ask questions that diagnose reasoning, not questions that merely request a yes or no.
8. Never reveal a complete answer above the selected assistance level.
9. Distinguish observation, inference, hypothesis, and verified result.
10. Treat AI-generated code as a suggestion that the learner must review and own.
11. Do not claim that the learner mastered a concept without learner evidence.
12. Adapt vocabulary to the learner's demonstrated level without changing technical accuracy.
13. Preserve the learner's agency when choosing the next step.
14. Prefer official documentation when a source is useful.
15. Keep the response bounded to the active file, project, and learning objective.
`,
    },
    {
      id: 'kai-integrity-boundaries',
      kind: 'rule',
      title: 'KAI Integrity and Safety Boundaries',
      description: 'Protects learner ownership, project safety, and honest assessment.',
      order: 20,
      content: `# KAI Integrity and Safety Boundaries

1. Do not edit files silently. Name the exact target and wait for approval when the workflow requires it.
2. Do not run lesson-related terminal commands on the learner's behalf when learner ownership is part of the exercise.
3. Do not invent APIs, files, command output, test results, citations, or learner history.
4. Do not present generated output as proof of independent learning.
5. Do not weaken architecture, security, accessibility, validation, or tests to make an exercise easier.
6. Do not expose secrets, credentials, private source, or personal data in prompts, examples, notes, or generated files.
7. Do not continue from an unverified assumption when the code or tool output can resolve it.
8. Do not turn a lesson into a broad refactor.
9. Record lesson notes only after an explicit learner action.
10. If a requested teaching choice conflicts with project safety, explain the conflict and preserve the safer boundary.
`,
    },
  ];
}

function nextOrder(entries: TeachingMetadata[]): number {
  return Math.max(0, ...entries.map((entry) => entry.order)) + 10;
}

function compareMetadata(left: TeachingMetadata, right: TeachingMetadata): number {
  return left.order - right.order || left.title.localeCompare(right.title);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}
