import { roleTargetSchema, type AppSettings, type CrewConfig, type CrewRole, type RoleTarget } from '@kai/contracts';
import { defaultLocalBuilder } from './components/guided-build-engine';

/**
 * The person's own Model team: which model plans and checks (the Coach, who is also the Architect and a crew's Lead) and
 * which builds (the Builder, who is also the Implementer and a crew's builders). It is saved once and used as the starting
 * point for a new Guided Build plan, a new Architect and Implementer split, and a new crew, so the same choice does not
 * have to be made in four places.
 *
 * It is a starting point only. Anything already set up in a plan, a split or a crew keeps what it has, and each can still
 * be changed for that one thing. Nothing here runs a model or reaches the network: it is two saved choices.
 */

export interface ModelTeam {
  coach: RoleTarget | null;
  builder: RoleTarget | null;
}

export const MODEL_TEAM_KEY = 'kai.modelTeam';

interface TeamStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): TeamStorage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

const EMPTY: ModelTeam = { coach: null, builder: null };

/** The saved team. A value that no longer parses (an old build, a hand edit) is ignored rather than trusted. */
export function readModelTeam(storage: TeamStorage | null = browserStorage()): ModelTeam {
  if (!storage) return EMPTY;
  try {
    const raw = storage.getItem(MODEL_TEAM_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as { coach?: unknown; builder?: unknown } | null;
    const coach = roleTargetSchema.safeParse(parsed?.coach);
    const builder = roleTargetSchema.safeParse(parsed?.builder);
    return { coach: coach.success ? coach.data : null, builder: builder.success ? builder.data : null };
  } catch {
    return EMPTY;
  }
}

export function writeModelTeam(team: ModelTeam, storage: TeamStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    if (!team.coach && !team.builder) storage.removeItem(MODEL_TEAM_KEY);
    else storage.setItem(MODEL_TEAM_KEY, JSON.stringify({ coach: team.coach, builder: team.builder }));
    return true;
  } catch {
    return false;
  }
}

export function hasModelTeam(team: ModelTeam): boolean {
  return team.coach !== null || team.builder !== null;
}

/**
 * Who a new Guided Build plan starts with. The saved team wins; with no saved Builder, a model on this computer or network
 * is the default (see `defaultLocalBuilder`); with no saved Coach, the agent in use plans, which is left as null here.
 */
export function startingTargets(settings: Pick<AppSettings, 'directApi' | 'savedLocalModels'>, storage?: TeamStorage | null): ModelTeam {
  const team = readModelTeam(storage);
  return { coach: team.coach, builder: team.builder ?? defaultLocalBuilder(settings) };
}

/**
 * A new crew's draft with the person's Model team on it: the Lead plans and checks as the Coach, and the builders build as
 * the Builder. Other roles (reviewers, security, designer and so on) keep their own choice, and a crew whose team was already
 * saved for the project is never passed through this.
 */
export function withTeamOnCrew(config: CrewConfig, team: ModelTeam): CrewConfig {
  const asRole = (role: CrewRole, target: RoleTarget): CrewRole => {
    const { api: _api, model: _model, ...rest } = role;
    if (target.execution === 'api' && target.api) {
      return { ...rest, execution: 'api', route: 'direct', api: target.api, ...(target.api.model ? { model: target.api.model } : {}) };
    }
    return { ...rest, execution: 'cli', agent: target.agent ?? role.agent, ...(target.model ? { model: target.model } : {}) };
  };
  return {
    ...config,
    roles: config.roles.map((role) => {
      if (role.kind === 'lead' && team.coach) return asRole(role, team.coach);
      if (role.kind === 'builder' && team.builder) return asRole(role, team.builder);
      return role;
    }),
  };
}
