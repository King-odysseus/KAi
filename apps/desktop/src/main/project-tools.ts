import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { diffHunks, planItemStateSchema, type AutonomyMode, type PermissionKey, type PermissionRule } from '@kai/contracts';
import type { ToolHookRunner } from './automation';
import { FileConflictError, readProjectFile, writeProjectFile } from './project-files';
import { RunGuard } from './run-guard';
import { readPlan, writePlan } from './plan-store';
import { isParallelCopy } from './parallel-session';
import { BACKGROUND_REFUSAL, launchesBackgroundProcess } from './process-cleanup';
import { findGitBash } from './terminal';
import { runTypeDiagnostics } from './type-diagnostics';
import { WEB_TOOLS, WebToolRuntime, webFetchToolInputSchema, webSearchToolInputSchema, webToolDefinitionsFor } from './web-tools';
import { outlineFile } from './repo-map';

const MAX_READ_BYTES = 512 * 1024;
const MAX_READ_LINES = 400;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_RESULTS = 500;
const MAX_WRITE_TEXT = 400_000;
const MAX_MULTI_EDITS = 40;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_TEXT = 100_000;
const MAX_COMMAND_LENGTH = 20_000;
const MAX_COMMAND_OUTPUT = 200_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
/** How long to keep reading a finished command's output before giving up on pipes a background process still holds. */
const OUTPUT_DRAIN_GRACE_MS = 400;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
]);

const outlineInputSchema = z.object({ path: z.string().min(1) }).strict();

const readFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  })
  .strict();

const searchFilesInputSchema = z
  .object({
    query: z.string().min(1).max(200),
    path: z.string().min(1).max(1_024).optional(),
    max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
    regex: z.boolean().optional(),
    glob: z.string().min(1).max(200).optional(),
  })
  .strict();

const listFilesInputSchema = z
  .object({
    pattern: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(1_024).optional(),
    max_results: z.number().int().min(1).max(MAX_LIST_RESULTS).optional(),
  })
  .strict();

const writeFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    content: z.string().max(MAX_WRITE_TEXT),
  })
  .strict();

const multiEditInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    edits: z
      .array(
        z
          .object({
            old_text: z.string().min(1).max(MAX_EDIT_TEXT),
            new_text: z.string().max(MAX_EDIT_TEXT),
            replace_all: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MULTI_EDITS),
  })
  .strict();

const deleteFileInputSchema = z.object({ path: z.string().min(1).max(1_024) }).strict();

const moveFileInputSchema = z
  .object({
    from: z.string().min(1).max(1_024),
    to: z.string().min(1).max(1_024),
  })
  .strict();

const replaceInFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    old_text: z.string().min(1).max(MAX_EDIT_TEXT),
    new_text: z.string().max(MAX_EDIT_TEXT),
    replace_all: z.boolean().optional(),
  })
  .strict();

const createFileInputSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    content: z.string().max(MAX_EDIT_TEXT),
  })
  .strict();

const updatePlanInputSchema = z
  .object({
    items: z.array(z.object({ text: z.string().trim().min(1).max(300), state: planItemStateSchema }).strict()).max(50),
  })
  .strict();

const diagnosticsInputSchema = z.object({ path: z.string().trim().min(1).max(1_024).optional() }).strict();

const runCommandInputSchema = z
  .object({
    command: z.string().trim().min(1).max(MAX_COMMAND_LENGTH),
    cwd: z.string().min(1).max(1_024).optional(),
    timeout_ms: z.number().int().min(100).max(MAX_COMMAND_TIMEOUT_MS).optional(),
  })
  .strict();

export const askUserInputSchema = z
  .object({
    question: z.string().trim().min(1).max(1_000),
    context: z.string().trim().min(1).max(2_000).optional(),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(4),
    // When true, a person may answer with their own words instead of one of the options.
    allow_free_text: z.boolean().optional(),
  })
  .strict();

export const exploreInputSchema = z
  .object({
    question: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const taskInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8_000),
    /** Optional model for the helper. Blank uses the parent run's model. */
    model: z.string().trim().min(1).max(100).optional(),
    /** True for a helper that edits files. Several in one round each work in their own copy of the project. */
    write: z.boolean().optional(),
  })
  .strict();

export const projectToolDefinitions = [
  {
    type: 'function',
    name: 'update_plan',
    description: 'Record or revise your plan for the current task: a short list of steps and which are done. Call this first for anything that takes more than a couple of steps, and again whenever a step finishes or the plan changes. It is what tells KAI whether the task is finished, so keep it current rather than describing the plan in your reply.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 50,
          description: 'The whole plan, in order. Replace the list rather than appending to it.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'One step, short enough to read at a glance.' },
              state: { type: 'string', enum: ['pending', 'active', 'done'], description: 'How far this step has got.' },
            },
            required: ['text', 'state'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'view_image',
    description: 'View a local PNG, JPEG, GIF or WebP image inside the active project. Use this to inspect pictures and saved screenshots directly.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Project-relative image path.' } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the active project. Paths are relative to the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        start_line: { type: 'integer', minimum: 1, description: 'Optional first line to return (1-based).' },
        end_line: { type: 'integer', minimum: 1, description: 'Optional last line to return (1-based).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'outline_file',
    description: 'List what a source file declares (functions, classes, constants, types, exports), each with its line number. One call shows a file\'s shape; then read_file the lines you need.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative path of the file.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_files',
    description: 'Search text files inside the active project for a case-insensitive string, or a regular expression when regex is true.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for, or a JavaScript regular expression when regex is true.' },
        path: { type: 'string', description: 'Optional project-relative file or directory to search.' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        glob: { type: 'string', description: 'Only search files whose project-relative path matches this glob, for example "src/**/*.ts".' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'replace_in_file',
    description: 'Replace exact text in an existing project file. Use this for code changes instead of rewriting a whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        old_text: { type: 'string', description: 'Exact existing text to replace.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every exact occurrence when true; otherwise require one occurrence.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_file',
    description: 'Create a new UTF-8 text file inside the active project. Existing files are never overwritten.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path for the new file.' },
        content: { type: 'string', description: 'Initial file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_files',
    description: 'List project files, optionally only those matching a glob such as "src/**/*.ts". Skips node_modules, build output and .git.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob matched against project-relative paths. Omit to list everything.' },
        path: { type: 'string', description: 'Optional project-relative directory to list under.' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_LIST_RESULTS },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'multi_edit',
    description: 'Apply several exact-text replacements to one file in order. All of them apply or none do, so use it for a change that needs more than one edit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        edits: {
          type: 'array',
          description: 'Replacements applied in order; each sees the result of the previous one.',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_text', 'new_text'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_file',
    description: 'Write the full content of a project file, creating it or replacing it. Prefer replace_in_file or multi_edit for small changes to a large file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative file path.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'move_file',
    description: 'Move or rename a project file. The destination must not exist.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Existing project-relative path.' },
        to: { type: 'string', description: 'New project-relative path.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_file',
    description: 'Delete one project file. Directories are never deleted.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'ask_user',
    description: 'Ask the user a question with a short list of answers when the task genuinely cannot proceed without their decision. The question appears in the conversation, so explain the relevant findings and trade-offs in context. Make each option understandable without relying on unexplained item numbers. Use this instead of ending your turn with a question in your reply.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A self-contained question, short enough to read at a glance.' },
        context: { type: 'string', description: 'Why this decision is needed now, what was found, and what each choice changes. Explain any item numbers or project-specific names used in the question or options.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: 'Two to four short, mutually exclusive answers the user can pick from.',
          items: { type: 'string' },
        },
        allow_free_text: { type: 'boolean', description: 'Set true if a typed answer is also acceptable, not only one of the options.' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'explore',
    description: 'Hand a question off to a read-only helper that searches and reads files to answer it, then reports back a short answer. Use this for a broad "where/how does X work" question instead of reading many files yourself — the helper\'s intermediate reads do not fill up your own context, only its answer does. The helper cannot edit files, run commands, or ask further questions; give it a question it can answer by reading.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to find out, specific enough for the helper to search for.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'task',
    description: 'Hand a self-contained side task to a helper agent with its own context. By default the helper is read-only: it reads and searches the project (and the web if enabled) and returns only its final answer. Set write to true for a helper that writes code: it can create and edit files, but still cannot run commands, ask questions, or start its own helpers. Call task several times in one turn and the helpers run at the same time; writing helpers each work in their own copy of the project, which is checked and merged back for you, and the result lists the files each one changed. Use helpers when a job has separate parts that do not touch the same files (a page, its tests and its styles; two unrelated modules), or to keep a lot of reading out of your own context. Do not use them for a small job, and never give two writing helpers the same file. Give each one everything it needs: it cannot see this conversation.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, with everything the helper needs to work on its own, including which files it owns.' },
        model: { type: 'string', description: 'Optional model for the helper. Leave out to use the same model as this run.' },
        write: { type: 'boolean', description: 'True if the helper should write or edit files. Needs Auto-edit or Full access. Leave out for a read-only helper.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'diagnostics',
    description: 'Read the project\'s current errors straight from its checker (TypeScript, or ruff/mypy for Python, cargo check for Rust, go vet for Go), as file, line, column, code and message. Cheaper and more exact than running a build and reading its output. Pass path to look at one file or folder. Run it after editing code to confirm you broke nothing.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional project-relative file or folder to report on. Omit for the whole project.' } },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_command',
    description: 'Run a shell command in the active project. Commands use your user permissions and may access resources outside the project, so approval is required outside Full mode.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Optional working directory relative to the project root.' },
        timeout_ms: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          description: 'Optional timeout in milliseconds. Defaults to 30000 and cannot exceed 120000.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

export type ProjectToolName = (typeof projectToolDefinitions)[number]['name'];

export interface ProjectToolExecution {
  ok: boolean;
  output: unknown;
  changedFile?: {
    path: string;
    action: 'edited' | 'created';
    summary: string;
    /** Unified diff of before/after, so the activity card can show the comparison. */
    diff?: string;
  };
}

/** A unified diff for the activity card, built from the before/after text the tool already has in hand. */
function unifiedDiff(filePath: string, before: string, after: string): string {
  const hunks = diffHunks(before, after);
  if (hunks.length === 0) return '';
  const clean = (line: string): string => line.replace(/\r?\n$/, '');
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.removed.length} +${hunk.newStart},${hunk.added.length} @@`);
    lines.push(...hunk.contextBefore.map((line) => ` ${clean(line)}`));
    lines.push(...hunk.removed.map((line) => `-${clean(line)}`));
    lines.push(...hunk.added.map((line) => `+${clean(line)}`));
    lines.push(...hunk.contextAfter.map((line) => ` ${clean(line)}`));
  }
  return lines.join('\n');
}

export type ProjectToolPolicy =
  | { decision: 'allow' }
  | { decision: 'ask'; title: string; detail: string; risk: 'low' | 'medium' | 'high' }
  | { decision: 'deny'; reason: string };

export interface ExternalToolPort {
  definitions(): Promise<readonly unknown[]>;
  policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy | undefined;
  execute(name: string, input: unknown, signal?: AbortSignal): Promise<ProjectToolExecution | undefined>;
}

// Commands that send work off this machine or change a shared service. They always need a human decision.
const PUBLISHING_COMMAND = /\b(?:git\s+(?:(?:-[Cc]\s+\S+|-{1,2}[\w-]+(?:=\S+)?)\s+)*push|gh\s+(?:pr\s+(?:create|merge|close|ready)|repo\s+(?:create|delete|edit)|release\s+(?:create|delete)|workflow\s+run)|npm\s+publish|pnpm\s+publish|yarn\s+publish|cargo\s+publish|docker\s+push)\b/i;

export function isPublishingCommand(command: string): boolean {
  return PUBLISHING_COMMAND.test(command);
}

const EDIT_TOOLS = new Set(['replace_in_file', 'create_file', 'multi_edit', 'write_file', 'move_file', 'delete_file']);

/** A file a text reader has no business opening, and which the refusal should name as such. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i;

/**
 * What a model needs to fix a call with bad arguments. The raw validation dump is meant for programmers: a model that
 * sent no arguments at all reads it as noise and repeats the same call.
 */
export function describeArgumentError(name: string, rawInput: unknown, error: z.ZodError): string {
  const problems = error.issues.map((issue) => {
    const field = issue.path.join('.') || 'arguments';
    return issue.code === 'invalid_type' && issue.received === 'undefined'
      ? `"${field}" is required (${issue.expected})`
      : `"${field}": ${issue.message}`;
  });
  const sent = rawInput === undefined || rawInput === null || (typeof rawInput === 'object' && Object.keys(rawInput as object).length === 0)
    ? 'You sent no arguments.'
    : `You sent: ${JSON.stringify(rawInput).slice(0, 300)}`;
  return `The ${name} call was not run because its arguments are invalid: ${problems.join('; ')}. ${sent} Call ${name} again and fill in every required argument.`;
}

export class DesktopProjectToolRuntime {
  private resolvedRoot: Promise<string> | undefined;
  /** Per-run limits: a spend ceiling and repeated-call detection. */
  readonly guard = new RunGuard();
  /** User-owned rules and tool hooks loaded for this project when the run started. */
  permissionRules: readonly PermissionRule[] = [];
  toolHook: ToolHookRunner | undefined;
  /** A nested helper gets only these tools. Undefined means every built-in tool. */
  toolFilter: ReadonlySet<string> | undefined;
  /** The conversation this run belongs to: the plan it keeps is that conversation's own, never the project's. */
  conversationId: string | undefined;

  constructor(
    private readonly root: string,
    private readonly customPermissions: Partial<Record<PermissionKey, boolean>> = {},
    /** Present when this run may use the web tools. Absent for nested helpers and older call sites. */
    private readonly web?: WebToolRuntime,
  ) {}

  /** An edit or shell command was refused for plan mode in this run. */
  private refusedForPlanMode = false;
  /** An edit tool has succeeded in this run. */
  private editsMade = 0;

  setPolicy(policy: { permissionRules?: readonly PermissionRule[]; toolHook?: ToolHookRunner }): void {
    this.permissionRules = policy.permissionRules ?? [];
    this.toolHook = policy.toolHook;
  }

  get rootPath(): string {
    return this.root;
  }

  /** The built-in tools this run may offer: the fixed project tools plus the web tools that are configured. */
  toolDefinitions(): readonly unknown[] {
    const all = [...projectToolDefinitions, ...webToolDefinitionsFor(this.web?.availability() ?? { search: false, fetch: false })];
    return this.toolFilter ? all.filter((definition) => this.toolFilter!.has((definition as { name: string }).name)) : all;
  }

  policy(name: string, autonomy: AutonomyMode): ProjectToolPolicy {
    // `diagnostics` runs the project's TypeScript compiler without a shell and with --noEmit, so it only reads.
    if (name === 'view_image' || name === 'read_file' || name === 'outline_file' || name === 'search_files' || name === 'list_files' || name === 'diagnostics') return { decision: 'allow' };
    // The plan is the model's own note about where the task has got to, and KAI reads it to decide whether a task
    // is finished — so it is allowed at every level, plan mode included. It writes `.kai/plan.json` and nothing
    // else: it cannot touch project source. Without this line it fell through to the deny below as an unknown tool,
    // and every API-run plan was refused, which left the finish signal with nothing to read.
    if (name === 'update_plan') return { decision: 'allow' };
    // Both only ever ask or read; neither can touch a project file. `direct-provider-runtime.ts` intercepts them
    // before they would reach `execute()` below — `ask_user` to raise the question through the approval port,
    // `explore` to run its own bounded read-only sub-loop — so allowing them here only governs whether the model
    // is offered the tool at all, which is also how nesting is prevented: a nested explore run is simply never
    // given these two tool definitions.
    if (name === 'ask_user' || name === 'explore' || name === 'task') return { decision: 'allow' };
    // Web tools only read public pages; they never touch a project file. They are allowed in every mode unless the
    // user switched them off, and Custom access can still require a decision when the network permission is off.
    if (WEB_TOOLS.has(name)) {
      const available = this.web?.availability();
      if (!available || (name === 'web_search' ? !available.search : !available.fetch)) {
        return {
          decision: 'deny',
          reason: name === 'web_search' ? 'Web search is switched off in Settings.' : 'Web fetch is switched off in Settings.',
        };
      }
      if (autonomy === 'custom' && !this.customPermissions.network) {
        return {
          decision: 'ask',
          title: name === 'web_search' ? 'Search the web?' : 'Read a web page?',
          detail: 'This reads a public web address. It does not change project files.',
          risk: 'low',
        };
      }
      return { decision: 'allow' };
    }
    if (name === 'run_command') {
      if (autonomy === 'plan') {
        this.refusedForPlanMode = true;
        return { decision: 'deny', reason: 'Plan mode does not allow shell commands.' };
      }
      if (autonomy === 'full') return { decision: 'allow' };
      if (autonomy === 'custom' && this.customPermissions.shellCommand) return { decision: 'allow' };
      return {
        decision: 'ask',
        title: 'Run a project command?',
        detail: 'Commands run with your user permissions and can access resources outside the project. Review the exact command and working directory before allowing it.',
        risk: 'high',
      };
    }
    if (!EDIT_TOOLS.has(name)) {
      return { decision: 'deny', reason: `Unknown project tool: ${name}.` };
    }
    if (autonomy === 'plan') {
      this.refusedForPlanMode = true;
      return { decision: 'deny', reason: `The current plan mode does not allow ${name}.` };
    }
    // Removing a file is the one edit that cannot be undone by another edit, so only Full access skips the question.
    if (name === 'delete_file') {
      if (autonomy === 'full' || (autonomy === 'custom' && this.customPermissions.workspaceEdit)) return { decision: 'allow' };
      return {
        decision: 'ask',
        title: 'Delete a project file?',
        detail: 'The model asked to delete a project file. A checkpoint can bring it back, but review the path before allowing it.',
        risk: 'medium',
      };
    }
    if (autonomy === 'autoEdit' || autonomy === 'full') return { decision: 'allow' };
    if (autonomy === 'custom' && this.customPermissions.workspaceEdit) return { decision: 'allow' };
    return {
      decision: 'ask',
      title: name === 'create_file' ? 'Create a project file?' : 'Edit a project file?',
      detail: 'The model requested a project file change. Review the tool arguments before allowing it.',
      risk: 'medium',
    };
  }

  async execute(name: string, rawInput: unknown, signal?: AbortSignal): Promise<ProjectToolExecution> {
    const result = await this.executeTool(name, rawInput, signal);
    if (result.ok && (EDIT_TOOLS.has(name) || name === 'run_command')) this.editsMade += 1;
    return result;
  }

  private async executeTool(name: string, rawInput: unknown, signal?: AbortSignal): Promise<ProjectToolExecution> {
    try {
      if (name === 'view_image') return await this.viewImage(deleteFileInputSchema.parse(rawInput));
      if (name === 'read_file') return await this.readFile(readFileInputSchema.parse(rawInput));
      if (name === 'outline_file') return await this.outline(outlineInputSchema.parse(rawInput));
      if (name === 'search_files') return await this.searchFiles(searchFilesInputSchema.parse(rawInput));
      if (name === 'replace_in_file') return await this.replaceInFile(replaceInFileInputSchema.parse(rawInput));
      if (name === 'create_file') return await this.createFile(createFileInputSchema.parse(rawInput));
      if (name === 'list_files') return await this.listFiles(listFilesInputSchema.parse(rawInput));
      if (name === 'multi_edit') return await this.multiEdit(multiEditInputSchema.parse(rawInput));
      if (name === 'write_file') return await this.writeFile(writeFileInputSchema.parse(rawInput));
      if (name === 'move_file') return await this.moveFile(moveFileInputSchema.parse(rawInput));
      if (name === 'delete_file') return await this.deleteFile(deleteFileInputSchema.parse(rawInput));
      if (name === 'run_command') return await this.runCommand(runCommandInputSchema.parse(rawInput), signal);
      if (name === 'diagnostics') {
        const input = diagnosticsInputSchema.parse(rawInput ?? {});
        if (input.path) await this.resolveInsideProject(input.path, false);
        const result = await runTypeDiagnostics(await this.projectRoot(), { path: input.path, signal });
        return { ok: result.ok, output: result };
      }
      if (name === 'web_search') {
        const input = webSearchToolInputSchema.parse(rawInput);
        const web = this.web;
        if (!web) return toolFailure('Web search is not available in this run.');
        try {
          const results = await web.search(input.query, input.limit, signal);
          return { ok: true, output: { query: input.query, results, trust: 'untrusted' } };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      }
      if (name === 'web_fetch') {
        const input = webFetchToolInputSchema.parse(rawInput);
        const web = this.web;
        if (!web) return toolFailure('Web fetch is not available in this run.');
        try {
          const page = await web.fetch(input.url, input.max_chars, signal);
          return { ok: true, output: { ...page, trust: 'untrusted' } };
        } catch (error) {
          return toolFailure(error instanceof Error ? error.message : String(error));
        }
      }
      if (name === 'update_plan') return await this.updatePlan(updatePlanInputSchema.parse(rawInput));
      // Both are handled earlier, in `direct-provider-runtime.ts`'s `executeToolCalls`, before a call ever reaches
      // here — `ask_user` needs the approval port to put the question to a person, and `explore` needs the
      // provider runtime to run its nested sub-loop. Reaching this branch means that interception was skipped.
      if (name === 'ask_user' || name === 'explore' || name === 'task') {
        return toolFailure(`${name} must be handled by the run loop, not called directly.`);
      }
      return toolFailure(`Unknown project tool: ${name}.`);
    } catch (error) {
      if (error instanceof z.ZodError) return toolFailure(describeArgumentError(name, rawInput, error));
      return toolFailure(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Records the plan for this task. The whole list is replaced each time, so the model reports the plan as it now
   * stands rather than a diff it could get wrong.
   *
   * The reply says how many are done, which is the one thing the model needs back: it is what tells a model that has
   * lost the thread whether it is finished, without it having to remember.
   */
  private async updatePlan(input: z.infer<typeof updatePlanInputSchema>): Promise<ProjectToolExecution> {
    if (!this.conversationId) return toolFailure('This run has no conversation to keep a plan for.');
    // A run whose edits were refused for plan mode, and that has made none, cannot honestly report new steps as done.
    // Refusing it tells the model the truth about where it stands instead of letting it tick everything off.
    if (this.refusedForPlanMode && this.editsMade === 0) {
      const before = await readPlan(this.root, this.conversationId);
      const doneBefore = before?.items.filter((item) => item.state === 'done').length ?? 0;
      const doneNow = input.items.filter((item) => item.state === 'done').length;
      if (doneNow > doneBefore) {
        return toolFailure(`Plan not updated: edits were refused in this run (plan mode) and no file has been changed, so no new step can be marked done. Keep those steps as they were and say what blocked you.`);
      }
    }
    const plan = await writePlan(this.root, this.conversationId, input.items, new Date().toISOString());
    const done = plan.items.filter((item) => item.state === 'done').length;
    const open = plan.items.length - done;
    return {
      ok: true,
      output: {
        summary: `Plan recorded: ${done} of ${plan.items.length} done${open > 0 ? `, ${open} still to do` : ', nothing outstanding'}.`,
        items: plan.items,
      },
    };
  }

  private async viewImage(input: { path: string }): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    const limit = 8 * 1024 * 1024;
    if (stat.size > limit) throw new Error(`Image exceeds the ${limit} byte limit.`);
    const bytes = await fs.readFile(target);
    if (bytes.length > limit) throw new Error(`Image exceeds the ${limit} byte limit.`);
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined;
    if (!mimeType) throw new Error('Unsupported image: use PNG, JPEG, GIF or WebP.');
    return { ok: true, output: { path: normalizeRelative(input.path), content: [{ type: 'image', mimeType, data: bytes.toString('base64') }] } };
  }

  private async outline(input: z.infer<typeof outlineInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_READ_BYTES) throw new Error(`${input.path} is ${stat.size} bytes; the outline limit is ${MAX_READ_BYTES} bytes.`);
    const outline = outlineFile(input.path, await fs.readFile(target, 'utf8'));
    return {
      ok: true,
      output: outline.length
        ? outline.map((entry) => `${entry.line}: ${entry.text}`).join('\n')
        : `No declarations found in ${input.path}: it is empty, or not a language KAI outlines. Use read_file.`,
    };
  }

  private async readFile(input: z.infer<typeof readFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`${input.path} is ${stat.size} bytes; the read limit is ${MAX_READ_BYTES} bytes.`);
    }
    const content = await fs.readFile(target, 'utf8');
    if (looksBinary(content)) {
      // Named for what it is: an agent handed an image used to be told only that the file was not UTF-8 text, so it
      // tried the next thing it could think of — once, a browser — instead of saying it could not see the picture.
      const image = IMAGE_FILE.test(input.path) ? ` It is an image (${path.extname(input.path).slice(1).toLowerCase()}), and this tool reads text: use view_image to inspect it.` : '';
      throw new Error(`${input.path} does not appear to be a UTF-8 text file.${image}`);
    }
    const lines = content.split(/\r?\n/);
    const start = input.start_line ?? 1;
    const requestedEnd = input.end_line ?? Math.min(lines.length, start + MAX_READ_LINES - 1);
    const end = Math.min(requestedEnd, start + MAX_READ_LINES - 1, lines.length);
    if (start > lines.length) {
      return { ok: true, output: { path: normalizeRelative(input.path), startLine: start, endLine: start - 1, totalLines: lines.length, text: '' } };
    }
    const selected = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    return {
      ok: true,
      output: {
        path: normalizeRelative(input.path),
        startLine: start,
        endLine: Math.max(start, end),
        totalLines: lines.length,
        text: selected,
        truncated: end < lines.length,
      },
    };
  }

  private async searchFiles(input: z.infer<typeof searchFilesInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path ?? '.', true);
    const stat = await fs.stat(target);
    const maxResults = input.max_results ?? 20;
    const needle = input.query.toLocaleLowerCase();
    let pattern: RegExp | undefined;
    if (input.regex) {
      try {
        pattern = new RegExp(input.query, 'i');
      } catch (error) {
        throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const globPattern = input.glob ? globToRegExp(input.glob) : undefined;
    const root = await this.projectRoot();
    const candidates = stat.isDirectory() ? await this.collectTextFiles(target) : [target];
    const files = globPattern
      ? candidates.filter((file) => globPattern.test(normalizeRelative(path.relative(root, file))))
      : candidates;
    const matches: Array<{ path: string; line: number; text: string }> = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;
      const fileStat = await fs.stat(file);
      if (fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(content)) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
        if (pattern ? pattern.test(lines[index]) : lines[index].toLocaleLowerCase().includes(needle)) {
          matches.push({
            path: normalizeRelative(path.relative(await this.projectRoot(), file)),
            line: index + 1,
            text: lines[index].slice(0, 500),
          });
        }
      }
    }

    return {
      ok: true,
      output: {
        query: input.query,
        matches,
        truncated: matches.length >= maxResults,
      },
    };
  }

  private async replaceInFile(input: z.infer<typeof replaceInFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_EDIT_FILE_BYTES) throw new Error(`${input.path} is too large to edit safely.`);
    const root = await this.projectRoot();
    const opened = await readProjectFile(root, input.path);
    const content = opened.content;
    const occurrences = countOccurrences(content, input.old_text);
    if (occurrences === 0) throw new Error(`The exact old_text was not found in ${input.path}.`);
    if (!input.replace_all && occurrences !== 1) {
      throw new Error(`The exact old_text occurs ${occurrences} times in ${input.path}; make it unique or set replace_all.`);
    }
    const next = input.replace_all
      ? content.split(input.old_text).join(input.new_text)
      : content.replace(input.old_text, () => input.new_text);
    await writeProjectFile(root, input.path, next, { expectedHash: opened.hash, eol: opened.eol, bom: opened.bom });
    return {
      ok: true,
      output: {
        path: normalizeRelative(input.path),
        replacements: input.replace_all ? occurrences : 1,
        occurrences,
      },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'edited',
        summary: `Replaced ${input.replace_all ? occurrences : 1} occurrence(s) in ${input.path}.`,
        diff: unifiedDiff(normalizeRelative(input.path), content, next),
      },
    };
  }

  private async createFile(input: z.infer<typeof createFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, false);
    try {
      await fs.writeFile(target, input.content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`${input.path} already exists. Use replace_in_file for an existing file.`);
      }
      throw error;
    }
    return {
      ok: true,
      output: { path: normalizeRelative(input.path), created: true, bytes: Buffer.byteLength(input.content, 'utf8') },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'created',
        summary: `Created ${input.path}.`,
        diff: unifiedDiff(normalizeRelative(input.path), '', input.content),
      },
    };
  }

  private async listFiles(input: z.infer<typeof listFilesInputSchema>): Promise<ProjectToolExecution> {
    const root = await this.projectRoot();
    const target = await this.resolveInsideProject(input.path ?? '.', true);
    if (!(await fs.stat(target)).isDirectory()) throw new Error(`${input.path} is not a directory.`);
    const pattern = input.pattern ? globToRegExp(input.pattern) : undefined;
    const limit = input.max_results ?? 200;
    const all = (await this.collectTextFiles(target))
      .map((file) => normalizeRelative(path.relative(root, file)))
      .filter((file) => !pattern || pattern.test(file))
      .sort();
    return { ok: true, output: { files: all.slice(0, limit), total: all.length, truncated: all.length > limit } };
  }

  private async multiEdit(input: z.infer<typeof multiEditInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
    if (stat.size > MAX_EDIT_FILE_BYTES) throw new Error(`${input.path} is too large to edit safely.`);
    const root = await this.projectRoot();
    const opened = await readProjectFile(root, input.path);
    let content = opened.content;
    let replacements = 0;
    for (const [index, edit] of input.edits.entries()) {
      const occurrences = countOccurrences(content, edit.old_text);
      if (occurrences === 0) throw new Error(`Edit ${index + 1}: the exact old_text was not found in ${input.path}. No edits were applied.`);
      if (!edit.replace_all && occurrences !== 1) {
        throw new Error(`Edit ${index + 1}: old_text occurs ${occurrences} times in ${input.path}; make it unique or set replace_all. No edits were applied.`);
      }
      content = edit.replace_all ? content.split(edit.old_text).join(edit.new_text) : content.replace(edit.old_text, () => edit.new_text);
      replacements += edit.replace_all ? occurrences : 1;
    }
    await writeProjectFile(root, input.path, content, { expectedHash: opened.hash, eol: opened.eol, bom: opened.bom });
    return {
      ok: true,
      output: { path: normalizeRelative(input.path), edits: input.edits.length, replacements },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'edited',
        summary: `Applied ${input.edits.length} edit(s) to ${input.path}.`,
        diff: unifiedDiff(normalizeRelative(input.path), opened.content, content),
      },
    };
  }

  private async writeFile(input: z.infer<typeof writeFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, false);
    const root = await this.projectRoot();
    let existed = true;
    let expectedHash: string | null = null;
    let before = '';
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error(`${input.path} is not a file.`);
      expectedHash = (await readProjectFile(root, input.path)).hash;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      existed = false;
    }
    if (existed) {
      const opened = await readProjectFile(root, input.path);
      if (opened.hash !== expectedHash) throw new FileConflictError(`${input.path} changed while the agent was preparing its edit.`);
      before = opened.content;
      await writeProjectFile(root, input.path, input.content, { expectedHash: opened.hash, eol: opened.eol, bom: opened.bom });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, { encoding: 'utf8', flag: 'wx' });
    }
    return {
      ok: true,
      output: { path: normalizeRelative(input.path), created: !existed, bytes: Buffer.byteLength(input.content, 'utf8') },
      changedFile: {
        path: normalizeRelative(input.path),
        action: existed ? 'edited' : 'created',
        summary: `${existed ? 'Rewrote' : 'Created'} ${input.path}.`,
        diff: unifiedDiff(normalizeRelative(input.path), before, input.content),
      },
    };
  }

  private async moveFile(input: z.infer<typeof moveFileInputSchema>): Promise<ProjectToolExecution> {
    const source = await this.resolveInsideProject(input.from, true);
    if (!(await fs.stat(source)).isFile()) throw new Error(`${input.from} is not a file.`);
    const destination = await this.resolveInsideProject(input.to, false);
    try {
      await fs.access(destination);
      throw new Error(`${input.to} already exists.`);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return {
      ok: true,
      output: { from: normalizeRelative(input.from), to: normalizeRelative(input.to) },
      changedFile: {
        path: normalizeRelative(input.to),
        action: 'edited',
        summary: `Moved ${input.from} to ${input.to}.`,
      },
    };
  }

  private async deleteFile(input: z.infer<typeof deleteFileInputSchema>): Promise<ProjectToolExecution> {
    const target = await this.resolveInsideProject(input.path, true);
    if (!(await fs.stat(target)).isFile()) throw new Error(`${input.path} is not a file. Directories are never deleted.`);
    const root = await this.projectRoot();
    const before = await readProjectFile(root, input.path).then((opened) => opened.content).catch(() => '');
    await fs.unlink(target);
    return {
      ok: true,
      output: { path: normalizeRelative(input.path), deleted: true },
      changedFile: {
        path: normalizeRelative(input.path),
        action: 'edited',
        summary: `Deleted ${input.path}.`,
        diff: unifiedDiff(normalizeRelative(input.path), before, ''),
      },
    };
  }

  private async runCommand(input: z.infer<typeof runCommandInputSchema>, signal?: AbortSignal): Promise<ProjectToolExecution> {
    if (signal?.aborted) return commandFailure('Command was cancelled before it started.', '', '', undefined);
    const cwd = await this.resolveInsideProject(input.cwd ?? '.', true);
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) throw new Error(`${input.cwd ?? '.'} is not a directory.`);

    // A card's copy of the project is deleted when the card is done. Anything left running in it holds the folder, so a
    // server or a background command is refused there; the project's check starts and stops what it needs.
    if (isParallelCopy(cwd) && (launchesBackgroundProcess(input.command) || isDevServerCommand(input.command))) {
      return commandFailure(BACKGROUND_REFUSAL, '', '', undefined);
    }

    // Dev servers deliberately do not exit. Waiting for one makes the normal
    // command timeout kill it and leaves the agent turn looking frozen.
    if (isDevServerCommand(input.command)) return this.startBackgroundServer(input.command, cwd);

    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let cancellationRequested = false;
    let timeoutRequested = false;
    let timeout: NodeJS.Timeout | undefined;
    const child = spawn(input.command, {
      cwd,
      shell: agentShell(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onAbort = (): void => {
      cancellationRequested = true;
      void terminateProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendLimited(stdout, chunk.toString('utf8'), MAX_COMMAND_OUTPUT);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const appended = appendLimited(stderr, chunk.toString('utf8'), MAX_COMMAND_OUTPUT);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });

    // 'close' waits for every process holding the output pipes to let go. A command that starts something in the
    // background (`start /b npm run dev`, `nohup ... &`) leaves that process holding them, so 'close' can be minutes
    // away or never come, and the tool call, the run and the Stop button all hang with it. Once the command itself
    // has exited, give any last output a moment to arrive and then stop waiting for the pipes.
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const finish = (code: number | null, signalName: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, signal: signalName });
      };
      child.once('error', reject);
      child.once('close', finish);
      child.once('exit', (code, signalName) => {
        const grace = setTimeout(() => finish(code, signalName), OUTPUT_DRAIN_GRACE_MS);
        grace.unref();
      });
    });
    timeout = setTimeout(() => {
      timeoutRequested = true;
      void terminateProcessTree(child);
    }, input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS);

    try {
      const result = await closed;
      const output = {
        exitCode: result.code,
        signal: result.signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
      };
      if (cancellationRequested) return commandFailure('Command was cancelled.', stdout, stderr, output);
      if (timeoutRequested) {
        return { ok: false, output: { ...output, timedOut: true, error: `Command timed out after ${input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS}ms.` } };
      }
      return { ok: result.code === 0, output };
    } catch (error) {
      if (cancellationRequested) return commandFailure('Command was cancelled.', stdout, stderr, undefined);
      if (timeoutRequested) return commandFailure(`Command timed out after ${input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS}ms.`, stdout, stderr, undefined);
      return commandFailure(error instanceof Error ? error.message : String(error), stdout, stderr, undefined);
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async startBackgroundServer(command: string, cwd: string): Promise<ProjectToolExecution> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '1' },
        ...backgroundServerOptions(process.platform),
      });
      child.once('error', (error) => resolve(commandFailure(error.message, '', '', undefined)));
      child.once('spawn', () => {
        child.unref();
        resolve({
          ok: true,
          output: {
            background: true,
            pid: child.pid ?? null,
            command,
            cwd,
            message: 'Dev server started in the background. It will keep running after this agent turn finishes.',
          },
        });
      });
    });
  }

  private async collectTextFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const pending = [root];
    while (pending.length > 0 && files.length < MAX_SEARCH_FILES) {
      const directory = pending.pop();
      if (!directory) break;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_SEARCH_FILES) break;
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }
    return files;
  }

  private async resolveInsideProject(requestedPath: string, mustExist: boolean): Promise<string> {
    const root = await this.projectRoot();
    const candidate = path.resolve(root, requestedPath);
    assertInside(root, candidate, requestedPath);

    if (mustExist) {
      const resolved = await fs.realpath(candidate);
      assertInside(root, resolved, requestedPath);
      return resolved;
    }

    let existingParent = path.dirname(candidate);
    while (true) {
      try {
        const resolvedParent = await fs.realpath(existingParent);
        assertInside(root, resolvedParent, requestedPath);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const next = path.dirname(existingParent);
        if (next === existingParent) throw new Error(`No existing parent directory was found for ${requestedPath}.`);
        existingParent = next;
      }
    }
    return candidate;
  }

  private projectRoot(): Promise<string> {
    this.resolvedRoot ??= fs.realpath(this.root).then(async (root) => {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error('The active project is not a directory.');
      return root;
    });
    return this.resolvedRoot;
  }
}

function assertInside(root: string, candidate: string, requestedPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the active project: ${requestedPath}.`);
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
    });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 1_000);
  timer.unref();
}

function appendLimited(current: string, appended: string, limit: number): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: Boolean(appended) };
  const remaining = limit - current.length;
  if (appended.length <= remaining) return { value: current + appended, truncated: false };
  return { value: current + appended.slice(0, remaining), truncated: true };
}

function commandFailure(
  message: string,
  stdout: string,
  stderr: string,
  output: Record<string, unknown> | undefined,
): ProjectToolExecution {
  return {
    ok: false,
    output: {
      ...(output ?? { stdout, stderr }),
      error: message,
    },
  };
}

/**
 * How a dev server the agent starts for itself is spawned.
 *
 * Detaching is what lets the server outlive KAI on Unix, and on Windows it does the opposite of what it looks like:
 * a detached child is given a console of its own, and `CREATE_NO_WINDOW` — what `windowsHide` sets — is ignored
 * while `DETACHED_PROCESS` is set. So `detached: true` with `windowsHide: true` opened a bare `C:\WINDOWS\System32`
 * console with the server's own output in it, and the agent's work nowhere. On Windows the server is left in KAI's
 * process tree instead, which KAI already ends on quit.
 */
export function backgroundServerOptions(
  platform: NodeJS.Platform,
): Pick<SpawnOptions, 'shell' | 'windowsHide' | 'detached' | 'stdio'> {
  return { shell: agentShell(platform), windowsHide: true, detached: platform !== 'win32', stdio: 'ignore' };
}

/**
 * The shell an agent-issued command actually runs in.
 *
 * `spawn(..., { shell: true })` takes the platform default, which on Windows is `cmd.exe` — a different shell
 * from the one KAI's own in-app terminal offers by default (Git Bash, see `terminal.ts`) and from the POSIX
 * shell every other platform already gets. An agent writes commands in the shape almost all of them are
 * trained on, which is Unix-style, and then hits cmd.exe quirks it had no reason to expect. Node runs a shell
 * given as a path the same way regardless of what the path is — `<shell> -c "<command>"` — which is exactly
 * what Git Bash wants, so pointing it there instead of at `true` is a drop-in change, not a new code path.
 * Falls back to the platform default when Git Bash is not installed, so a command still runs either way.
 *
 * Takes the platform rather than reading `process.platform` directly so `backgroundServerOptions`, which is
 * already written to be tested against a platform other than the one the tests actually run on, stays that way.
 */
function agentShell(platform: NodeJS.Platform = process.platform): string | true {
  if (platform !== 'win32') return true;
  return findGitBash() ?? true;
}

function isDevServerCommand(command: string): boolean {
  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)(?:\s|$)|(?:^|\s)(?:vite|next\s+dev|nuxt\s+dev|webpack(?:\s+serve)?)(?:\s|$)/i.test(command.trim());
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

/** A path glob: `**` crosses folders, `*` and `?` stay inside one, and a pattern with no slash matches at any depth. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${normalized.includes('/') ? '' : '(?:.*/)?'}${source}$`, 'i');
}

function looksBinary(content: string): boolean {
  return content.slice(0, 4_096).includes('\u0000');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
}

function normalizeRelative(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function toolFailure(message: string): ProjectToolExecution {
  return { ok: false, output: { error: message } };
}
