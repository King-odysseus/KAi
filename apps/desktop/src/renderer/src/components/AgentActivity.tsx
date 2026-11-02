import { AlertTriangle, CheckCircle2, ChevronDown, FileCode2, Loader2, Pause, Search, Terminal, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PersistedEvent } from '@kai/contracts';
import { relativeTime } from '../types';
import { UiButton } from './UiButton';

export type AgentActivityKind = 'idle' | 'planning' | 'reading' | 'editing' | 'checking' | 'working' | 'waiting' | 'paused' | 'blocked' | 'completed';

export interface AgentActivitySummary {
  kind: AgentActivityKind;
  label: string;
  detail: string;
  lastAction: string | null;
  lastAt: string | null;
  learningNuggets: readonly string[];
}

export function deriveAgentActivity(
  events: readonly PersistedEvent[],
  running: boolean,
  paused: boolean,
  awaitingApproval: boolean,
  /** Auto has parked the run until the person answers. Not something they paused, so it must not read as one. */
  autoWaiting = false,
): AgentActivitySummary {
  const meaningful = [...events].reverse();
  const last = meaningful.find((event) => event.type !== 'text.delta' && event.type !== 'cost.update') ?? null;
  const action = last ? describeEvent(last) : null;
  const learningNuggets = codingNuggets(events);
  if (awaitingApproval) return { kind: 'waiting', label: 'Waiting for approval', detail: 'KAI paused before a protected action.', lastAction: action, lastAt: last?.timestamp ?? null, learningNuggets };
  // Said before "Paused": this state is drawn as paused everywhere else, and the label that read "suspended, and can
  // continue from the same point" sent a person who had paused nothing looking for the run they thought they had held.
  if (running && autoWaiting) return { kind: 'waiting', label: 'Waiting for you', detail: 'Auto stopped to ask something. Answer in the composer, or press Resume to let it carry on without an answer.', lastAction: action, lastAt: last?.timestamp ?? null, learningNuggets };
  if (running && paused) return { kind: 'paused', label: 'Paused', detail: 'The run is suspended and can continue from the same point.', lastAction: action, lastAt: last?.timestamp ?? null, learningNuggets };
  if (last?.type === 'error') return { kind: 'blocked', label: running ? 'Blocked' : 'Failed', detail: last.message, lastAction: action, lastAt: last.timestamp, learningNuggets };
  if (last?.type === 'permission.escalation') return { kind: 'waiting', label: 'Waiting for permission', detail: last.reason || last.permission, lastAction: action, lastAt: last.timestamp, learningNuggets };

  const recentTool = meaningful.find((event): event is Extract<PersistedEvent, { type: 'tool.call' }> => event.type === 'tool.call');
  if (running && recentTool) {
    const classified = classifyTool(recentTool.name, recentTool.input);
    const state = recentTool.status === 'completed' || recentTool.status === 'failed'
      ? { kind: 'working' as const, label: 'Reviewing results', detail: classified.detail }
      : classified;
    return { kind: state.kind, label: state.label, detail: state.detail, lastAction: action, lastAt: recentTool.timestamp, learningNuggets };
  }
  if (running) return { kind: 'planning', label: 'Thinking', detail: 'Reading context and deciding the next action.', lastAction: action, lastAt: last?.timestamp ?? null, learningNuggets };
  if (last?.type === 'turn.changes') return { kind: 'completed', label: 'Changes ready to review', detail: `${last.files.length} file${last.files.length === 1 ? '' : 's'} changed in the latest turn.`, lastAction: action, lastAt: last.timestamp, learningNuggets };
  if (last?.type === 'agent.lifecycle' && last.status === 'completed') return { kind: 'completed', label: 'Completed', detail: last.detail ?? 'The agent finished the latest turn.', lastAction: action, lastAt: last.timestamp, learningNuggets };
  return { kind: 'idle', label: 'Ready', detail: last ? 'No agent run is active.' : 'Start a task when you are ready.', lastAction: action, lastAt: last?.timestamp ?? null, learningNuggets };
}

/**
 * Short teaching prompts based on observable work only. These explain a useful coding idea without exposing private
 * model reasoning, hidden prompts, or speculative claims about what the agent is thinking.
 */
export function codingNuggets(events: readonly PersistedEvent[]): readonly string[] {
  const evidence = events.slice(-20).map((event) => {
    if (event.type === 'tool.call') {
      let input = '';
      try { input = JSON.stringify(event.input ?? ''); } catch { /* Ignore an unusual tool payload. */ }
      return `${event.name} ${input}`;
    }
    if (event.type === 'file.change' || event.type === 'file.edit.applied') return JSON.stringify(event);
    return event.type;
  }).join(' ').toLowerCase();
  if (/react|\.tsx|jsx|useeffect|usestate/.test(evidence)) return [
    'React re-renders when state or props change; keep derived values in render and use effects for external synchronization.',
    'A component is easier to test when it receives data and actions as props instead of reaching into global state.',
  ];
  if (/django|python|manage\.py|urlpatterns|django_rest/.test(evidence)) return [
    'Django views should validate input at the boundary and keep business rules out of templates.',
    'A Django model constraint protects data even when a request path or admin action forgets to validate it.',
  ];
  if (/typescript|\.ts\b|\.tsx\b|zod|schema/.test(evidence)) return [
    'TypeScript narrows types at boundaries; validate unknown data once so the rest of the code stays simple.',
    'A runtime schema protects the application when data comes from a file, network, or another process.',
  ];
  if (/postgres|postgresql|sql|migration|prisma|database|query/.test(evidence)) return [
    'A database index is a shortcut for a common lookup; add one for real query patterns, but remember it also costs space and slows writes.',
    'A transaction keeps related database changes together, so a failure does not leave half the operation saved.',
  ];
  if (/test|spec|vitest|jest|pytest|assert/.test(evidence)) return [
    'A useful regression test names the behavior that failed, so it keeps its value even if the implementation changes.',
    'Fast unit checks catch local mistakes; an integration check proves that the pieces work together.',
  ];
  if (/fetch|http|api|endpoint|request|response|json/.test(evidence)) return [
    'API-backed UI has three normal states to design: loading, failure, and an empty result.',
    'Keep transport errors separate from validation errors so the user gets a useful recovery action.',
  ];
  if (/css|\.css|tailwind|flex|grid|responsive/.test(evidence)) return [
    'Many layout bugs come from the parent sizing context; inspect grid and flex constraints before adding offsets.',
    'Responsive design is easier when the layout changes at meaningful content breakpoints instead of device labels.',
  ];
  if (/git|commit|branch|worktree|diff/.test(evidence)) return [
    'Small commits and checkpoints make changes easier to review, revert, and resume after an interruption.',
    'A diff is evidence of what changed; a passing check is separate evidence that the behavior still works.',
  ];
  return [
    'Small, focused changes are easier to verify than a broad refactor mixed with a feature.',
    'The best next check is the one that could disprove the current approach quickly.',
  ];
}

function classifyTool(name: string, input: unknown): { kind: AgentActivityKind; label: string; detail: string } {
  const normalized = name.toLowerCase();
  const detail = toolDetail(input);
  if (normalized === 'explore') {
    return { kind: 'reading', label: 'Exploring', detail: detail || name };
  }
  if (normalized === 'ask_user') {
    return { kind: 'waiting', label: 'Asking a question', detail: detail || name };
  }
  if (/(read|search|grep|glob|list|find|open|cat|view)/.test(normalized)) {
    return { kind: 'reading', label: 'Reading files', detail: detail || name };
  }
  if (/(test|lint|check|build|typecheck|verify|compile)/.test(normalized) || /(?:^|\s)(npm test|npm run (?:test|lint|build|typecheck)|pytest|cargo test|go test)/i.test(detail)) {
    return { kind: 'checking', label: 'Running checks', detail: detail || name };
  }
  if (/(apply_patch|edit|write|create|delete|rename|replace)/.test(normalized)) {
    return { kind: 'editing', label: 'Editing files', detail: detail || name };
  }
  if (/(shell|command|exec|terminal|bash|powershell)/.test(normalized)) {
    return { kind: 'checking', label: 'Running a command', detail: detail || name };
  }
  return { kind: 'working', label: 'Using a tool', detail: detail || name };
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.path ?? record.filePath ?? record.pattern ?? record.query ?? record.question ?? record.description;
  return typeof value === 'string' ? value.slice(0, 500) : '';
}

function describeEvent(event: PersistedEvent): string {
  if (event.type === 'tool.call') return `${event.name}${event.status === 'failed' ? ' failed' : ''}`;
  if (event.type === 'diff.proposal') return `Proposed changes to ${event.filePath}`;
  if (event.type === 'file.edit.applied') return `Changed ${event.filePath}`;
  if (event.type === 'file.change') return `${event.action} ${event.path}`;
  if (event.type === 'turn.changes') return `Changed ${event.files.length} file${event.files.length === 1 ? '' : 's'}`;
  if (event.type === 'error') return event.message;
  if (event.type === 'approval.request') return event.title;
  if (event.type === 'permission.escalation') return `Permission requested: ${event.permission}`;
  if (event.type === 'plan.update') return 'Updated the plan';
  if (event.type === 'agent.lifecycle') return `${event.status}${event.detail ? `: ${event.detail}` : ''}`;
  return event.type.replaceAll('.', ' ');
}

export function AgentActivityStrip({ events, running, paused, autoWaiting = false, awaitingApproval, elapsedSeconds = 0, tokenEstimate = 0 }: {
  events: readonly PersistedEvent[];
  running: boolean;
  paused: boolean;
  autoWaiting?: boolean;
  awaitingApproval: boolean;
  elapsedSeconds?: number;
  tokenEstimate?: number;
}): ReactNode {
  const activity = deriveAgentActivity(events, running, paused, awaitingApproval, autoWaiting);
  const [expanded, setExpanded] = useState(false);
  const [providerNugget, setProviderNugget] = useState<string | null>(null);
  const requestedProviderNugget = useRef(false);
  const fallbackNugget = activity.learningNuggets[Math.floor(elapsedSeconds / 10) % activity.learningNuggets.length] ?? activity.learningNuggets[0];
  const nugget = providerNugget ?? fallbackNugget;
  useEffect(() => {
    if (!running) {
      requestedProviderNugget.current = false;
      setProviderNugget(null);
      return;
    }
    if (requestedProviderNugget.current || !fallbackNugget) return;
    requestedProviderNugget.current = true;
    void window.kaiDesktop.generateTeachingDraft({
      kind: 'method',
      topic: nuggetTopic(events),
      instructions: 'Return ONLY one or two short sentences that teach one concrete coding concept in simple words. No title, headings, labels, markdown, template, lesson plan, teaching sequence, meta-commentary, or discussion of these instructions. Do not mention hidden reasoning, private prompts, or this run.',
      baseContent: activity.detail,
    }).then((response) => {
      const cleaned = response.ok ? cleanProviderNugget(response.data.content) : null;
      if (cleaned) setProviderNugget(cleaned);
    }).catch(() => undefined);
  }, [running]);
  if (!running && !paused && !awaitingApproval && !['waiting', 'blocked'].includes(activity.kind)) return null;
  return (
    <section className={`agent-activity ${activity.kind}${expanded ? ' is-expanded' : ''}`} aria-live="polite" aria-label="Agent activity">
      {nugget && <div className="agent-activity-nugget" aria-label="Learning nugget"><strong>Learning nugget</strong><span>{nugget}</span></div>}
      <UiButton type="button" className="agent-activity-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} title={expanded ? 'Hide activity details' : 'Show full activity details'}>
        <span className="agent-activity-icon">{activityIcon(activity.kind)}</span>
        <span className="agent-activity-copy">
          <span className="agent-activity-summary-line">
            <span className="agent-activity-heading"><strong>{activity.label}</strong>{activity.lastAt && <small>Last action {relativeTime(activity.lastAt)}</small>}</span>
            <span className="agent-activity-detail">{activity.detail}</span>
          </span>
        </span>
        <ChevronDown className="agent-activity-chevron" size={13} />
      </UiButton>
      {expanded && <div className="agent-activity-expanded">
        <p>{activity.detail}</p>
        {activity.lastAction && <p><strong>Last action:</strong> {activity.lastAction}</p>}
        {nugget && <p className="agent-activity-expanded-nugget"><strong>Learning nugget:</strong> {nugget}</p>}
      </div>}
      {(running || paused || awaitingApproval) && (() => {
        const agents = activeAgentCount(events);
        return (
          <div className="agent-activity-metrics" aria-label="Run progress">
            <span>{elapsedSeconds}s</span>
            {tokenEstimate > 0 && <span>~{formatTokens(tokenEstimate)} tokens</span>}
            {agents > 0 && <span>{agents} agent{agents === 1 ? '' : 's'}</span>}
          </div>
        );
      })()}
    </section>
  );
}

function nuggetTopic(events: readonly PersistedEvent[]): string {
  const evidence = events.slice(-20).map((event) => {
    if (event.type === 'tool.call') return `${event.name} ${JSON.stringify(event.input ?? '')}`;
    if (event.type === 'file.change' || event.type === 'file.edit.applied') return JSON.stringify(event);
    return event.type;
  }).join(' ').toLowerCase();
  if (/react|\.tsx|jsx|useeffect|usestate/.test(evidence)) return 'React components, state, and rendering';
  if (/django|python|manage\.py|urlpatterns/.test(evidence)) return 'Django views, validation, and models';
  if (/typescript|\.ts\b|\.tsx\b|zod|schema/.test(evidence)) return 'TypeScript types and runtime validation';
  if (/postgres|postgresql|sql|migration|prisma|database|query/.test(evidence)) return 'Postgres data modelling, queries, and indexes';
  if (/css|\.css|tailwind|flex|grid|responsive/.test(evidence)) return 'CSS layout and responsive design';
  if (/test|spec|vitest|jest|pytest|assert/.test(evidence)) return 'software testing and regression checks';
  if (/fetch|http|api|endpoint|request|response|json/.test(evidence)) return 'APIs, requests, and error handling';
  return 'the coding concept behind the current task';
}

/** Provider output is optional enrichment; never let a returned prompt/template appear as a teaching nugget. */
function cleanProviderNugget(value: string): string | null {
  const text = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /concept[- ]in[- ]context|teaching sequence|when to use|instructions|prompt|lesson plan|meta[- ]commentary|private reasoning/i.test(text)) return null;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const concise = sentences.slice(0, 2).join(' ').trim();
  return concise.length >= 30 && concise.length <= 520 ? concise : null;
}

/**
 * Which `tool.call` names are actually a nested agent run, not an ordinary tool: claude's own `Task` tool when the
 * composer runs through the CLI, and `explore` (a nested read-only helper loop) when it runs through the Direct API.
 */
const SUB_AGENT_TOOL_NAMES = new Set(['task', 'explore']);

/** How many sub-agents this run currently has going — started calls whose matching result has not arrived yet. */
export function activeAgentCount(events: readonly PersistedEvent[]): number {
  const started = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool.call' || !SUB_AGENT_TOOL_NAMES.has(event.name.toLowerCase()) || !event.callId) continue;
    if (event.status === 'started') started.add(event.callId);
    else started.delete(event.callId);
  }
  return started.size;
}

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function activityIcon(kind: AgentActivityKind): ReactNode {
  if (kind === 'reading') return <Search size={15} />;
  if (kind === 'editing') return <FileCode2 size={15} />;
  if (kind === 'checking') return <Terminal size={15} />;
  if (kind === 'waiting' || kind === 'blocked') return <AlertTriangle size={15} />;
  if (kind === 'completed') return <CheckCircle2 size={15} />;
  if (kind === 'paused') return <Pause size={15} />;
  if (kind === 'planning' || kind === 'working') return <Loader2 className="spin" size={15} />;
  return <Wrench size={15} />;
}
