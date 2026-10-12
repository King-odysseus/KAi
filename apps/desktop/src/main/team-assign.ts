import {
  classifyWork,
  createDefaultAgentTeam,
  isBuiltInRole,
  resolveRole,
  roleConfigFor,
  type AgentCapability,
  type AgentTeam,
  type AutoModelSettings,
  type RouteMode,
  type TeamAssignment,
  type TeamBilling,
  type TeamPart,
  type TeamResolvedAssignee,
  type TeamRoleConfig,
  type TeamRoleId,
  type TeamRecordEntry,
  type TeamRecordAdvice,
  TEAM_ROLE_IDS,
  tierModelFor,
  WORK_LEVEL_LABEL,
  type WorkLevel,
} from '@kai/contracts';
import { betterRecord, MIN_TEAM_JOBS, recordPhrase, roleRecord } from './team-record';

/** What KAI can reach right now, gathered by the caller so this module stays pure. */
export interface AssignmentEnvironment {
  capabilities: ReadonlyArray<Pick<AgentCapability, 'id' | 'displayName' | 'available' | 'state' | 'supportsRoutes' | 'unavailableReason'>>;
  /** `local` means a model on this machine (LM Studio): free per request, and fine for routine parts. */
  api: { available: boolean; displayName: string; unavailableReason?: string; local?: boolean; provider?: string };
  proxyReady: boolean;
  /** Set by the caller; only Windows changes a choice (see scoreFor). */
  platform?: NodeJS.Platform;
  records?: readonly TeamRecordEntry[];
  projectId?: string;
  /** Models to use for light, standard and heavy parts; absent or disabled leaves the model to the agent. */
  autoModel?: AutoModelSettings;
}

/** A reviewer that skims misses things, so a read-only part never runs on the light model. */
export function partLevel(part: Pick<TeamPart, 'title' | 'prompt' | 'paths' | 'effort'>, access: 'read' | 'edit'): WorkLevel {
  const level = part.effort ?? classifyWork(`${part.title}
${part.prompt}`, { fileCount: part.paths.length }).level;
  return access === 'read' && level === 'light' ? 'standard' : level;
}

/**
 * The model a part runs on when its role has none pinned. Only CLIs on their own subscription are steered: the
 * proxy maps models itself, and API mode uses the provider model from Settings.
 */
export function autoModelFor(
  assignee: TeamResolvedAssignee,
  route: RouteMode,
  level: WorkLevel,
  autoModel: AutoModelSettings | undefined,
): string | undefined {
  if (assignee === 'api' || route !== 'direct') return undefined;
  return tierModelFor(autoModel, assignee, level);
}

export interface Reach {
  route: RouteMode;
  /** Set when the agent could only be reached by falling back to the proxy. */
  note?: string;
}

/**
 * How good each agent is at each role, 0-10. Starting points KAI can be corrected on, not benchmarks: the
 * Balanced preset only uses them to break ties between agents that are all ready.
 */
const STRENGTH: Record<TeamRoleId, Record<TeamResolvedAssignee, number>> = {
  orchestrator: { claude: 11, codex: 10, gemini: 7, qwen: 6, kimi: 6, api: 7 },
  frontend: { claude: 6, gemini: 6, codex: 6, kimi: 8, qwen: 6, api: 10 },
  backend: { codex: 6, claude: 6, qwen: 6, kimi: 8, gemini: 6, api: 10 },
  tests: { codex: 8, claude: 8, qwen: 7, kimi: 6, gemini: 6, api: 6 },
  securityReviewer: { claude: 9, codex: 8, gemini: 6, kimi: 5, qwen: 5, api: 6 },
  codeReviewer: { claude: 9, codex: 8, gemini: 7, kimi: 6, qwen: 6, api: 6 },
  docs: { claude: 8, kimi: 8, qwen: 7, gemini: 7, codex: 6, api: 6 },
};

/** Agents whose limits are worth saving for the hard parts of a job. */
const PREMIUM: ReadonlySet<TeamResolvedAssignee> = new Set(['claude', 'codex']);
/** Order used when two agents score the same, so a plan is the same every time. */
const TIE_ORDER: readonly TeamResolvedAssignee[] = ['claude', 'codex', 'gemini', 'qwen', 'kimi', 'api'];
const CANDIDATES: readonly TeamResolvedAssignee[] = TIE_ORDER;

export function billingFor(assignee: TeamResolvedAssignee, route: RouteMode, localApi = false): TeamBilling {
  if (assignee === 'api') return localApi && route === 'direct' ? 'local' : 'api';
  return route === 'proxy' ? 'proxy' : 'subscription';
}

/** Fill any role the saved settings are missing, so older settings files and hand edits never break a plan. */
export function completeTeam(team: AgentTeam | undefined): AgentTeam {
  const defaults = createDefaultAgentTeam();
  return {
    preset: team?.preset ?? defaults.preset,
    roles: { ...defaults.roles, ...(team?.roles ?? {}) },
    custom: team?.custom ?? [],
  };
}

function roleConfig(team: AgentTeam, role: string): TeamRoleConfig {
  return roleConfigFor(team, role);
}

/** A role the user defined has no built-in track record, so no agent is favoured for it: readiness and preset decide. */
const NEUTRAL_STRENGTH = 6;

function strengthOf(role: string, assignee: TeamResolvedAssignee): number {
  return isBuiltInRole(role) ? STRENGTH[role][assignee] : NEUTRAL_STRENGTH;
}

export function agentName(assignee: TeamResolvedAssignee, env: AssignmentEnvironment): string {
  if (assignee === 'api') return env.api.displayName;
  return env.capabilities.find((capability) => capability.id === assignee)?.displayName ?? assignee;
}

/** Whether an agent can run right now, and over which route. Null when it cannot. */
export function reach(
  assignee: TeamResolvedAssignee,
  routeChoice: TeamRoleConfig['route'],
  env: AssignmentEnvironment,
): Reach | null {
  if (assignee === 'api') {
    if (!env.api.available) return null;
    if (routeChoice === 'proxy') return env.proxyReady ? { route: 'proxy' } : null;
    return { route: 'direct' };
  }
  const capability = env.capabilities.find((candidate) => candidate.id === assignee);
  if (!capability) return null;
  const proxyCapable = capability.supportsRoutes.includes('proxy');
  if (routeChoice === 'proxy') return proxyCapable && env.proxyReady && capability.state !== 'not_installed' && capability.state !== 'unavailable' ? { route: 'proxy' } : null;
  if (capability.available) return { route: 'direct' };
  // The proxy carries its own key, so a signed-out CLI can still work through it.
  if (routeChoice === 'auto' && capability.state === 'signed_out' && proxyCapable && env.proxyReady) {
    return { route: 'proxy', note: `${capability.displayName} is signed out, so it runs through your proxy (per-token charges).` };
  }
  return null;
}

function whyUnreachable(assignee: TeamResolvedAssignee, env: AssignmentEnvironment): string {
  if (assignee === 'api') return env.api.unavailableReason ?? `${env.api.displayName} is not set up`;
  const capability = env.capabilities.find((candidate) => candidate.id === assignee);
  return capability?.unavailableReason ?? `${assignee} is not available`;
}

interface Scored {
  assignee: TeamResolvedAssignee;
  reach: Reach;
  score: number;
}

function scoreFor(role: string, assignee: TeamResolvedAssignee, team: AgentTeam, env: AssignmentEnvironment): number {
  const info = resolveRole(team, role);
  let score = strengthOf(role, assignee);
  const premium = PREMIUM.has(assignee);
  if (team.preset === 'balanced' && premium && info.routine) score -= 2;
  if (team.preset === 'budget' && premium) score -= info.access === 'read' ? 2 : 4;
  // Kimi Code only takes its prompt as a command-line argument, which Windows caps far below KAI's prompts.
  if (assignee === 'kimi' && env.platform === 'win32') score -= 4;
  // The Budget preset exists to spare paid limits, so a free local model takes routine parts.
  if (assignee === 'api' && env.api.local && team.preset === 'budget' && info.routine) score += 3;
  // Keep paid CLI subscriptions for architecture and hard reviews; use the configured DeepSeek API for implementation.
  if (info.access === 'edit' && PREMIUM.has(assignee)) score -= 3;
  if (assignee === 'api' && env.api.provider?.toLowerCase() === 'deepseek' && info.access === 'edit') score += 4;
  if (assignee === 'kimi' && info.access === 'edit') score += 2;
  return score;
}

function pickAuto(
  role: string,
  config: TeamRoleConfig,
  team: AgentTeam,
  env: AssignmentEnvironment,
  avoid: ReadonlySet<TeamResolvedAssignee>,
): Scored | null {
  let ready: Scored[] = [];
  for (const assignee of CANDIDATES) {
    const found = reach(assignee, config.route, env);
    if (!found) continue;
    ready.push({ assignee, reach: found, score: scoreFor(role, assignee, team, env) });
  }
  // A reviewer must not mark its own homework: skip the agents that wrote code, unless nobody else is ready.
  const independent = ready.filter((candidate) => !avoid.has(candidate.assignee));
  if (avoid.size > 0 && independent.length > 0) ready = independent;
  ready.sort((left, right) => right.score - left.score || TIE_ORDER.indexOf(left.assignee) - TIE_ORDER.indexOf(right.assignee));
  const best = ready.at(0);
  if (!best) return null;
  const baseline = roleRecord(env.records ?? [], role, best.assignee, env.projectId);
  if (!baseline || baseline.jobs < MIN_TEAM_JOBS) return best;
  // Compare only to the original winner, avoiding a chain of near-ties that could erase the preset's intent.
  const adjustment = (candidate: Scored): number => candidate.score - strengthOf(role, candidate.assignee);
  const contenders = ready.filter((candidate) => best.score - candidate.score <= 1 && adjustment(candidate) === adjustment(best));
  let winner = best;
  let rate = baseline.successRate;
  for (const candidate of contenders) {
    const record = roleRecord(env.records ?? [], role, candidate.assignee, env.projectId);
    if (record && record.jobs >= MIN_TEAM_JOBS && record.successRate > rate) {
      winner = candidate;
      rate = record.successRate;
    }
  }
  return winner;
}

export interface OrchestratorChoice {
  assignee: TeamResolvedAssignee;
  route: RouteMode;
  reason: string;
  warnings: string[];
}

/** Who plans the job. KAI's own API mode by default, falling back to the best ready CLI. */
export function resolveOrchestrator(teamInput: AgentTeam, env: AssignmentEnvironment): OrchestratorChoice | null {
  const team = completeTeam(teamInput);
  const config = roleConfig(team, 'orchestrator');
  const warnings: string[] = [];
  if (config.assignee !== 'auto') {
    const pinned = config.assignee;
    const found = reach(pinned, config.route, env);
    if (found) {
      return { assignee: pinned, route: found.route, reason: `You chose ${agentName(pinned, env)} to plan.`, warnings: found.note ? [found.note] : [] };
    }
    warnings.push(`${agentName(pinned, env)} cannot plan right now (${whyUnreachable(pinned, env)}), so KAI chose another agent.`);
  }
  // Planning and architecture belong to a ready Claude or Codex subscription. API credits are reserved for building.
  const picked = pickAuto('orchestrator', { ...config, assignee: 'auto' }, team, { ...env, api: { ...env.api, available: false } }, new Set());
  if (!picked) return null;
  return {
    assignee: picked.assignee,
    route: picked.reach.route,
    reason: `${agentName(picked.assignee, env)} is the strongest ready agent for planning.`,
    warnings: [...warnings, ...(picked.reach.note ? [picked.reach.note] : [])],
  };
}

export interface AssignmentResult {
  assignments: TeamAssignment[];
  warnings: string[];
}

/**
 * Choose an agent for every part. Editing parts are decided first, so a reviewer can be steered away from the
 * agent that wrote the code it is reviewing.
 */
export function assignTeam(parts: readonly TeamPart[], teamInput: AgentTeam, env: AssignmentEnvironment): AssignmentResult {
  const team = completeTeam(teamInput);
  const warnings: string[] = [];
  const byPart = new Map<string, TeamAssignment>();
  const authors = new Set<TeamResolvedAssignee>();
  const ordered = [
    ...parts.filter((part) => resolveRole(team, part.role).access === 'edit'),
    ...parts.filter((part) => resolveRole(team, part.role).access === 'read'),
  ];

  for (const part of ordered) {
    const info = resolveRole(team, part.role);
    const config = roleConfig(team, part.role);
    let choice: Scored | null = null;
    let reason = '';

    if (config.assignee !== 'auto') {
      const found = reach(config.assignee, config.route, env);
      if (found) {
        choice = { assignee: config.assignee, reach: found, score: 0 };
        reason = `You chose ${agentName(config.assignee, env)} for ${info.label}.`;
      } else {
        warnings.push(`${info.label}: ${agentName(config.assignee, env)} is not ready (${whyUnreachable(config.assignee, env)}), so KAI picked another agent.`);
      }
    }
    if (!choice) {
      choice = pickAuto(part.role, config, team, env, info.access === 'read' ? authors : new Set());
      if (choice) {
        const bits = [`Best ready fit for ${info.label} on the ${team.preset} preset.`];
        if (info.access === 'read') {
          bits.push(authors.has(choice.assignee) ? 'Warning: it also wrote some of this code.' : 'It did not write the code it reviews.');
        }
        reason = bits.join(' ');
        if (info.access === 'read' && authors.has(choice.assignee)) {
          warnings.push(`${info.label} "${part.title}" is ${agentName(choice.assignee, env)}, which also wrote some of the code. Pick a different agent if you want an independent review.`);
        }
      }
    }
    if (!choice) {
      throw new Error(`No agent is ready for ${info.label} ("${part.title}"). Install and sign in to a CLI agent, or set up Direct API in Settings.`);
    }
    if (choice.reach.note) warnings.push(`${info.label}: ${choice.reach.note}`);
    if (choice.assignee === 'kimi' && env.platform === 'win32') {
      warnings.push(`${info.label} "${part.title}" is on Kimi Code, which Windows limits to about 30,000 characters of prompt. A large part may fail; pick another agent if it does.`);
    }
    if (info.access === 'edit') authors.add(choice.assignee);
    const record = roleRecord(env.records ?? [], part.role, choice.assignee, env.projectId);
    if (record) reason = `${reason} ${agentName(choice.assignee, env)} ${recordPhrase(record)}.`;
    const level = partLevel(part, info.access);
    const tierModel = config.model ? undefined : autoModelFor(choice.assignee, choice.reach.route, level, env.autoModel);
    if (tierModel) reason = `${reason} ${WORK_LEVEL_LABEL[level]} work, so it runs on ${tierModel}.`;
    const model = config.model ?? tierModel;
    reason = reason.slice(0, 500);
    byPart.set(part.id, {
      partId: part.id,
      assignee: choice.assignee,
      suggestedAssignee: choice.assignee,
      route: choice.reach.route,
      ...(model ? { model } : {}),
      reason,
      billing: billingFor(choice.assignee, choice.reach.route, env.api.local),
    });
  }

  // Every part was assigned above, so nothing is dropped here; flatMap keeps the order without an assertion.
  return { assignments: parts.flatMap((part) => byPart.get(part.id) ?? []), warnings };
}

/** Advice follows the unsaved draft but never changes it; only ready alternatives can be suggested. */
export function teamAdvice(teamInput: AgentTeam, env: AssignmentEnvironment): TeamRecordAdvice[] {
  const team = completeTeam(teamInput);
  const roles = [...TEAM_ROLE_IDS.filter((role) => role !== 'orchestrator'), ...team.custom.map((role) => role.id)];
  return roles.flatMap((role): TeamRecordAdvice[] => {
    const config = roleConfigFor(team, role);
    const current = config.assignee === 'auto' ? pickAuto(role, config, team, env, new Set())?.assignee : config.assignee;
    if (!current) return [];
    const records = CANDIDATES.flatMap((agent) => roleRecord(env.records ?? [], role, agent, env.projectId) ?? []);
    const baseline = records.find((record) => record.assignee === current) ?? null;
    const alternative = betterRecord(baseline, records.filter((record) => reach(record.assignee, config.route, env)));
    return [{
      role, current, records,
      ...(alternative && baseline ? { suggestion: {
        assignee: alternative.assignee,
        text: `${agentName(alternative.assignee, env)} ${recordPhrase(alternative)}; ${agentName(current, env)} ${recordPhrase(baseline)}.`,
        fingerprint: JSON.stringify([env.projectId ?? 'all', role, baseline, alternative]),
      } } : {}),
    }];
  });
}
