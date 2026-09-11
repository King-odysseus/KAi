import * as vscode from 'vscode';
import type { AgentId, AutonomyMode, PermissionKey, RouteMode } from '../core/types';
import { migrateAutonomyMode } from '../core/types';

const KEYS = {
  agent: 'kai.project.agent',
  route: 'kai.project.route',
  autonomy: 'kai.project.autonomy',
  customPermissions: 'kai.project.customPermissions',
  alwaysAllowRules: 'kai.project.alwaysAllowRules',
} as const;

/**
 * Per-project preference store.
 *
 * Reads/writes agent, route, and autonomy preferences scoped to
 * the current VS Code workspace. Falls back to global KAI settings
 * when no project-level overrides exist.
 */
export class ProjectPreferences {
  constructor(private readonly workspaceState: vscode.Memento) {}

  getAgent(fallback: AgentId): AgentId {
    return this.workspaceState.get<AgentId>(KEYS.agent, fallback);
  }

  getRoute(fallback: RouteMode): RouteMode {
    return this.workspaceState.get<RouteMode>(KEYS.route, fallback);
  }

  getAutonomy(fallback: AutonomyMode): AutonomyMode {
    // Migrate a possibly-legacy value stored by an older KAI version.
    return migrateAutonomyMode(this.workspaceState.get<string>(KEYS.autonomy, fallback));
  }

  async setAgent(agent: AgentId): Promise<void> {
    await this.workspaceState.update(KEYS.agent, agent);
  }

  async setRoute(route: RouteMode): Promise<void> {
    await this.workspaceState.update(KEYS.route, route);
  }

  async setAutonomy(autonomy: AutonomyMode): Promise<void> {
    await this.workspaceState.update(KEYS.autonomy, autonomy);
  }

  getCustomPermissions(): Partial<Record<PermissionKey, boolean>> {
    return this.workspaceState.get(KEYS.customPermissions, {});
  }

  async setCustomPermissions(allowed: Partial<Record<PermissionKey, boolean>>): Promise<void> {
    await this.workspaceState.update(KEYS.customPermissions, allowed);
  }

  getAlwaysAllowRules(): string[] {
    return this.workspaceState.get(KEYS.alwaysAllowRules, []);
  }

  async setAlwaysAllowRules(rules: string[]): Promise<void> {
    await this.workspaceState.update(KEYS.alwaysAllowRules, rules);
  }

  /**
   * Returns all three project preferences, falling back to the provided
   * global defaults when no override exists.
   */
  getState(
    defaultAgent: AgentId,
    defaultRoute: RouteMode,
    defaultAutonomy: AutonomyMode,
  ): { agent: AgentId; route: RouteMode; autonomy: AutonomyMode } {
    return {
      agent: this.getAgent(defaultAgent),
      route: this.getRoute(defaultRoute),
      autonomy: this.getAutonomy(defaultAutonomy),
    };
  }
}
