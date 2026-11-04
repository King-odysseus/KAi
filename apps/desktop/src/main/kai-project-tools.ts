import { z } from 'zod';
import {
  ARTIFACT_KINDS,
  artifactKindSchema,
  boardStatusSchema,
  planItemStateSchema,
  readyCards,
  securityFindingSaveInputSchema,
  securityFindingSeveritySchema,
  securityFindingStatusSchema,
  type ArtifactKind,
  type BoardCard,
} from '@kai/contracts';
import { writePlan } from './plan-store';
import type { StudioArtifacts } from './artifacts';
import type { StudioBoardStore } from './board';
import type { SecurityFindingsStore } from './security-findings-store';
import type { SpecStore } from './spec-store';

/**
 * The `kai-project` server: the studio's artifacts and board, offered to any agent that speaks MCP. It exists so a
 * Claude, Codex, Qwen or Gemini session works the same board as a KAI one, under the same rules.
 *
 * Every tool goes through `spec-store.ts` and `board.ts`; nothing here writes a file itself. That is what makes the
 * promise true — an outside agent gets no shortcut past the checks, and in particular cannot mark a card `done`
 * that has not passed, because `board.move` refuses it before this module sees the answer.
 */

export interface KaiProjectPorts {
  /** The project the server was started for. One process, one project. */
  projectId: string;
  projectRoot(): Promise<string>;
  spec: SpecStore;
  artifacts: StudioArtifacts;
  board: StudioBoardStore;
  /**
   * Where an audit files what it reproduced. Absent when the server was started without a findings file, in which
   * case the save tool is not offered at all rather than offered and then refusing.
   */
  findings?: SecurityFindingsStore;
  now(): string;
}

export interface KaiProjectTool {
  name: string;
  description: string;
  /** The tool's input as a Zod raw shape, which is what the MCP SDK takes. */
  input: z.ZodRawShape;
  run(input: Record<string, unknown>): Promise<unknown>;
}

const cardIdField = z.string().min(1).max(120).describe('The board card id, from get_board.');
const agentField = z.string().min(1).max(120).describe('Your own name, so the card records who held it.');

export function createKaiProjectTools(ports: KaiProjectPorts): KaiProjectTool[] {
  const tools: KaiProjectTool[] = [];
  const boardSummary = (card: BoardCard) => ({
    id: card.id,
    title: card.title,
    kind: card.kind,
    status: card.status,
    dependsOn: card.dependsOn,
    needsArtifacts: card.needsArtifacts,
    designRef: card.designRef,
    stale: card.stale,
    claimedBy: card.claimedBy,
    runCount: card.runs.length,
  });

  tools.push(
    {
      // The same plan the Direct API path keeps, so a CLI session is not told to maintain something it cannot write.
      // CLAUDE.md and the run briefing both assume this tool exists.
      name: 'update_plan',
      description:
        'Record or revise your plan for the current task: a short list of steps and which are done. Call this first for anything that takes more than a couple of steps, and again whenever a step finishes or the plan changes. It is what tells KAI whether the task is finished, so keep it current rather than describing the plan in your reply.',
      input: {
        conversationId: z.string().min(1).max(120).optional().describe('The task id the run briefing gave you. The plan is kept under it.'),
        items: z
          .array(
            z.object({
              text: z.string().min(1).max(300).describe('One step, short enough to read at a glance.'),
              state: planItemStateSchema.describe('How far this step has got.'),
            }),
          )
          .max(50)
          .describe('The whole plan, in order. Replace the list rather than appending to it.'),
      },
      run: async (input) => {
        const items = z.array(z.object({ text: z.string().min(1).max(300), state: planItemStateSchema })).max(50).parse(input.items);
        // A CLI agent reaches this server through a config that cannot say which tab it serves, so the briefing hands it
        // the id. Without one there is no task to attach a plan to, and saying so beats writing a plan nobody reads.
        const conversationId = typeof input.conversationId === 'string' ? input.conversationId : undefined;
        if (!conversationId) throw new Error('Pass the conversationId from your run briefing: the plan is kept per task.');
        const plan = await writePlan(await ports.projectRoot(), conversationId, items, ports.now());
        const done = plan.items.filter((item) => item.state === 'done').length;
        const open = plan.items.length - done;
        return {
          summary: `Plan recorded: ${done} of ${plan.items.length} done${open > 0 ? `, ${open} still to do` : ', nothing outstanding'}.`,
          items: plan.items,
        };
      },
    },
    {
      // The finish line for a persona that produces evidence but not code: the report is a file the person can
      // read later, not a paragraph that scrolls away with the chat.
      name: 'write_report',
      description:
        'Write one Markdown report under .kai/spec/reports. Use it to finish a plan, review, test, audit or operate task: the commands you ran, the file and line for each claim, and what you could not verify. The file is kept in the project and versioned like every other spec artifact.',
      input: {
        kind: z.enum(['plan', 'review', 'build', 'test', 'audit', 'operate']).describe('What kind of pass produced this report.'),
        title: z.string().min(1).max(200).describe('One specific line, for example "Test triage for the checkout change".'),
        body: z.string().min(1).max(60_000).describe('The report in Markdown. Evidence first; do not pad it.'),
      },
      run: async (input) => {
        const kind = z.enum(['plan', 'review', 'build', 'test', 'audit', 'operate']).parse(input.kind);
        const title = z.string().min(1).max(200).parse(input.title);
        const body = z.string().min(1).max(60_000).parse(input.body);
        const now = ports.now();
        const stamp = `${now.slice(0, 10)}-${now.slice(11, 16).replace(':', '')}`;
        const relative = `reports/${kind}/${stamp}-${reportSlug(title)}.md`;
        const content = `# ${title}\n\n- kind: ${kind}\n- written: ${now}\n\n${body.trim()}\n`;
        const result = await ports.spec.write(await ports.projectRoot(), relative, content);
        return { path: `.kai/spec/${relative}`, version: result.version };
      },
    },
    {
      name: 'list_artifacts',
      description:
        'List the studio artifacts under .kai/spec with their version, who wrote them and whether they are stale. Read one with read_artifact.',
      input: {},
      run: async () => {
        const catalog = await ports.artifacts.read(ports.projectId);
        return {
          project: ports.projectId,
          artifacts: catalog.artifacts.map((entry) => ({
            kind: entry.kind,
            path: entry.path,
            version: entry.version,
            updatedAt: entry.updatedAt,
            generatedBy: entry.generatedBy,
            dependsOn: entry.dependsOn,
            stale: entry.stale,
            staleReason: entry.staleReason,
          })),
        };
      },
    },
    {
      name: 'read_artifact',
      description:
        'Read one artifact by kind (list_artifacts shows which exist: brief, prd, stories, stack, flows, style-guide, tokens, pages, decisions, architecture, conventions, acceptance, risks, glossary, setup), or any other file under .kai/spec by its spec-relative path, such as status.md.',
      input: {
        kind: artifactKindSchema.optional().describe('An artifact kind, for the files the studio manages.'),
        path: z.string().min(1).max(300).optional().describe('A path relative to .kai/spec, for anything else.'),
      },
      run: async (input) => {
        const kind = input.kind as ArtifactKind | undefined;
        const relative = input.path as string | undefined;
        if (!kind && !relative) throw new Error(`Name a kind (${ARTIFACT_KINDS.join(', ')}) or a path.`);
        if (kind && relative) throw new Error('Name either a kind or a path, not both.');
        const content = kind
          ? await ports.artifacts.readText(ports.projectId, kind)
          : await ports.spec.read(await ports.projectRoot(), specRelative(relative!));
        if (content === null) throw new Error(`There is no ${kind ?? relative} yet.`);
        return { path: kind ?? `.kai/spec/${relative}`, content };
      },
    },
    {
      name: 'get_board',
      description:
        'Read the board: every card with its status, dependencies and whether it is stale. Claim a ready card with claim_task before working it.',
      input: {},
      run: async () => {
        const board = await ports.board.read(ports.projectId);
        return {
          project: ports.projectId,
          cards: board.cards.map(boardSummary),
          ready: readyCards(board).map((card) => card.id),
          // The card's own brief, so an agent knows what to do without a second round trip.
          briefs: Object.fromEntries(
            readyCards(board).map((card) => [card.id, { title: card.title, story: card.story, acceptance: card.acceptance, prompt: card.prompt, route: card.route }]),
          ),
        };
      },
    },
    {
      name: 'claim_task',
      description: 'Take a ready card so no other agent works it. The card moves to inProgress and records you as its holder.',
      input: { cardId: cardIdField, agent: agentField },
      run: async (input) => boardSummary(await ports.board.claim(ports.projectId, input.cardId as string, input.agent as string)),
    },
    {
      name: 'move_task',
      description:
        'Move a card to another status. The same rules apply as inside KAI: moving to ready needs its dependencies done, and moving to done needs a passing check whose files still match the tree — so done will be refused until a check is recorded.',
      input: {
        cardId: cardIdField,
        status: boardStatusSchema,
        note: z.string().max(4_000).optional().describe('Why, when blocking or handing over.'),
      },
      run: async (input) =>
        boardSummary(
          await ports.board.move(ports.projectId, input.cardId as string, input.status as BoardCard['status'], (input.note as string) ?? ''),
        ),
    },
    {
      name: 'submit_output',
      description:
        'Record a finished turn against the card you hold: what you changed and a summary. The card goes to review for the user, or to blocked when you could not finish. It never goes to done — only a passing check does that.',
      input: {
        cardId: cardIdField,
        agent: agentField,
        model: z.string().max(120).optional(),
        summary: z.string().max(4_000).describe('What you did, and anything the reviewer needs to know.'),
        files: z.array(z.string().max(300)).max(200).default([]).describe('The files you changed, project-relative.'),
        outcome: z.enum(['review', 'blocked']).default('review').describe('review when the work is done but unchecked; blocked when you could not finish.'),
      },
      run: async (input) => {
        const cardId = input.cardId as string;
        const agent = input.agent as string;
        const summary = input.summary as string;
        const files = (input.files as string[]) ?? [];
        const outcome = (input.outcome as 'review' | 'blocked') ?? 'review';
        const held = await ports.board.read(ports.projectId);
        const card = held.cards.find((candidate) => candidate.id === cardId);
        if (!card) throw new Error(`No card ${cardId} on the board.`);
        // Submitting without claiming would let a card skip the board's queue; the claim is the lock.
        if (card.status !== 'inProgress' || card.claimedBy !== agent) {
          throw new Error(`Card ${cardId} is not held by ${agent}; claim it with claim_task before submitting output.`);
        }
        await ports.board.recordRun(ports.projectId, cardId, { agent, model: (input.model as string) ?? null, at: ports.now(), files });
        return boardSummary(await ports.board.move(ports.projectId, cardId, outcome, summary));
      },
    },
  );

  // Offered only when this server was started with the findings file. The audit prompt tells an agent to call it
  // "if it is available", so a server without one is a supported shape, not a broken tool.
  if (ports.findings) {
    const findings = ports.findings;
    tools.push({
      name: 'save_security_finding',
      description:
        'File one reproduced security finding in the person\'s Security Auditor log. Local only: the finding must come from this project\'s own code and a dev server you started on localhost. Call it once per finding, after you can reproduce it; do not file speculation, style opinions, or anything you could not show. Never include a real secret or live credential in the evidence — redact it. Filing the same issue again updates the existing record, so a re-scan does not duplicate it.',
      input: {
        severity: securityFindingSeveritySchema.describe('How much this issue matters. Do not inflate it.'),
        vulnClass: z.string().min(1).max(80).describe('A short slug such as sql-injection, broken-auth, secrets-in-code, path-traversal, ssrf, dependency-cve.'),
        title: z.string().min(1).max(200).describe('One specific line, for example "Login form accepts \' OR 1=1 and bypasses auth".'),
        location: z.string().min(1).max(500).describe('A file and line for a static finding (src/api/login.ts:42), or the local method and route for a dynamic one.'),
        evidence: z.string().min(1).max(4_000).describe('The exact input or request and the exact unexpected result, enough to reproduce in one step. Redact credentials.'),
        conceptCard: z.string().min(1).max(4_000).describe('For a learner: what this bug class is, why this instance is exploitable, and the general fix pattern.'),
        status: securityFindingStatusSchema.optional().describe('Set "fixed" only when a verify pass re-tested it and the reproduction no longer works.'),
        id: z.string().min(1).max(200).optional().describe('The existing finding id, on a verify pass, so that record is updated.'),
      },
      run: async (input) => {
        // Built field by field rather than spread: the fingerprint and the seen/verified stamps are the store's
        // business, and a model must not be able to choose the identity two findings dedupe under.
        const saved = await findings.add(securityFindingSaveInputSchema.parse({
          severity: input.severity,
          vulnClass: input.vulnClass,
          title: input.title,
          location: input.location,
          evidence: input.evidence,
          conceptCard: input.conceptCard,
          ...(input.status ? { status: input.status } : {}),
          ...(input.id ? { id: input.id } : {}),
        }));
        return {
          id: saved.id,
          status: saved.status,
          title: saved.title,
          location: saved.location,
          summary: `Filed "${saved.title}" as ${saved.severity} (${saved.status}).`,
        };
      },
    });
  }

  return tools;
}

/** A file-system-safe name for a report title; the timestamp in front keeps two reports of the same title apart. */
function reportSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'report';
}

/** The spec store takes spec-relative paths and rejects an absolute one; a `..` segment would still leave the root. */
function specRelative(relative: string): string {
  const segments = relative.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) throw new Error('A spec path may not climb out of .kai/spec.');
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}
