import { describe, expect, it } from 'vitest';
import { CREW_ROLE_INFO, CREW_ROLE_KINDS, TEAM_ROLE_IDS, TEAM_ROLE_INFO, createDefaultAgentTeam, roleAutoAdd } from '../packages/contracts/src';
import { completeTeam } from '../apps/desktop/src/main/team-assign';
import { buildOrchestratorPrompt } from '../apps/desktop/src/main/team-plan';

describe('licence and legal-compliance roles', () => {
  it('are agent team roles that only read and are never added unasked', () => {
    for (const role of ['licenseReviewer', 'complianceReviewer'] as const) {
      expect(TEAM_ROLE_IDS).toContain(role);
      expect(TEAM_ROLE_INFO[role].access).toBe('read');
      expect(roleAutoAdd(undefined, role)).toBe('never');
      expect(createDefaultAgentTeam().roles[role]).toBeDefined();
    }
  });

  it('appear on a team saved before they existed', () => {
    const older = createDefaultAgentTeam();
    delete (older.roles as Partial<typeof older.roles>).licenseReviewer;
    delete (older.roles as Partial<typeof older.roles>).complianceReviewer;
    const team = completeTeam(older);
    expect(team.roles.licenseReviewer).toBeDefined();
    expect(team.roles.complianceReviewer).toBeDefined();
  });

  it('are offered to the orchestrator when it splits a goal', () => {
    const prompt = buildOrchestratorPrompt('Ship the app in Nigeria and the EU');
    expect(prompt).toContain('"licenseReviewer"');
    expect(prompt).toContain('"complianceReviewer"');
  });

  it('are crew role kinds with a description', () => {
    for (const kind of ['license', 'compliance'] as const) {
      expect(CREW_ROLE_KINDS).toContain(kind);
      expect(CREW_ROLE_INFO[kind].does.length).toBeGreaterThan(20);
    }
  });
});
