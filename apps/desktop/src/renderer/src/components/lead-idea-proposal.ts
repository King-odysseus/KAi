import type { GuidedBuild, GuidedBuildStep } from '@kai/contracts';
import { addIdeaPrompt } from './guided-build-engine';

export interface LeadIdeaStepProposal {
  title: string;
  why: string;
  filesToEdit: string[];
  filesToRead: string[];
  instructions: string;
  doneChecks: string[];
  checkCommand: string;
}

export interface LeadIdeaProposal {
  status: 'proposal' | 'questions' | 'not_yet' | 'conflict';
  title: string;
  summary: string;
  why: string;
  how: string;
  risks: string[];
  simplerOption: string;
  learning: string;
  questions: string[];
  conflicts: string[];
  ideaRecord: string;
  decisionRecord: string;
  goalOrScopeChanged: boolean;
  briefScopeUpdate: string;
  planTitle: string;
  steps: LeadIdeaStepProposal[];
}

const PROPOSAL_SHAPE = `{
  "status": "proposal | questions | not_yet | conflict",
  "title": "short title",
  "summary": "what the idea would change",
  "why": "why this is useful",
  "how": "how it would work",
  "risks": ["risk"],
  "simplerOption": "a smaller way to get most of the value",
  "learning": "what the developer will learn",
  "questions": ["at most three questions; use an empty list when ready"],
  "conflicts": ["existing decision and why this clashes, or an empty list"],
  "ideaRecord": "complete append-only Markdown entry for ideas.md",
  "decisionRecord": "complete append-only Markdown entry for decisions.md after approval",
  "goalOrScopeChanged": false,
  "briefScopeUpdate": "append-only text when goalOrScopeChanged is true, otherwise empty",
  "planTitle": "updated plan title",
  "steps": [{"title":"one small step","why":"reason","filesToEdit":["one project-relative path"],"filesToRead":[],"instructions":"specific change","doneChecks":["verifiable result"],"checkCommand":"command to run"}]
}`;

export function leadIdeaCoachPrompt(input: {
  idea: string;
  planTitle: string;
  steps: readonly GuidedBuildStep[];
  style: GuidedBuild['style'];
  detail: GuidedBuild['detail'];
  questions: 'blocked' | 'decisions' | 'each-step';
}): string {
  const updatedPlan = addIdeaPrompt(input.idea, input.planTitle, input.steps, input.style, input.detail, input.questions);
  return `You are the read-only Lead helping shape a new project idea. Read the current plan, decisions and relevant code supplied with the user's message. Ask no more than three questions total; if answers are needed, set status to "questions", list them, and do not offer approval yet. You may recommend "not_yet" or "conflict" when the idea should wait or contradicts a decision. Explain why, how, risks, a simpler option and what the developer will learn in beginner-friendly language. Do not edit or write any file.

Use the existing plan update below as guidance; do not drop existing work. Never mark a completed step incomplete. ${updatedPlan}

Return exactly one JSON object between LEAD_IDEA_PROPOSAL and END_LEAD_IDEA_PROPOSAL markers, matching this shape. Include a structured proposal with exact append-only records and small steps. Each step must name at least one file to edit, done checks, and a check command. Set goalOrScopeChanged only if the goal or scope changes, and then provide a briefScopeUpdate. If there is no plan yet, set steps to the proposed plan. Never include file content that replaces existing text.

LEAD_IDEA_PROPOSAL
${PROPOSAL_SHAPE}
END_LEAD_IDEA_PROPOSAL`;
}

function string(value: unknown): value is string { return typeof value === 'string'; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }

export function parseLeadIdeaProposal(text: string): LeadIdeaProposal | null {
  const match = /LEAD_IDEA_PROPOSAL\s*([\s\S]*?)\s*END_LEAD_IDEA_PROPOSAL/i.exec(text);
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    if (!['proposal', 'questions', 'not_yet', 'conflict'].includes(String(item.status))) return null;
    if (![item.title, item.summary, item.why, item.how, item.simplerOption, item.learning, item.ideaRecord, item.decisionRecord, item.briefScopeUpdate, item.planTitle].every(string)) return null;
    if (!strings(item.risks) || !strings(item.questions) || item.questions.length > 3 || !strings(item.conflicts) || typeof item.goalOrScopeChanged !== 'boolean' || !Array.isArray(item.steps)) return null;
    const steps: LeadIdeaStepProposal[] = [];
    for (const rawStep of item.steps) {
      if (!rawStep || typeof rawStep !== 'object') return null;
      const step = rawStep as Record<string, unknown>;
      if (![step.title, step.why, step.instructions, step.checkCommand].every((part) => string(part) && part.trim().length > 0)
        || !strings(step.filesToEdit) || step.filesToEdit.length === 0 || !strings(step.filesToRead) || !strings(step.doneChecks) || step.doneChecks.length === 0) return null;
      if ([...step.filesToEdit, ...step.filesToRead].some((path) => path.startsWith('/') || path.includes('..') || path.includes('\\'))) return null;
      steps.push({ title: step.title as string, why: step.why as string, filesToEdit: step.filesToEdit, filesToRead: step.filesToRead, instructions: step.instructions as string, doneChecks: step.doneChecks, checkCommand: step.checkCommand as string });
    }
    if (item.status === 'proposal' && (steps.length === 0 || !(item.ideaRecord as string).trim() || !(item.decisionRecord as string).trim())) return null;
    if (item.status === 'questions' && item.questions.length === 0) return null;
    return { ...item, status: item.status as LeadIdeaProposal['status'], steps } as LeadIdeaProposal;
  } catch { return null; }
}

export function isLeadIdeaRequest(question: string): boolean {
  return /\b(?:new idea|idea for|what if|could we add|should we add|propose (?:a |an )?(?:feature|change)|plan (?:a |an )?(?:feature|change))\b/i.test(question);
}
