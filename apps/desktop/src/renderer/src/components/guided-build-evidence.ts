import { confirmDialog } from './AppDialog';
import type { CheckEvidence } from './guided-build-engine';

/**
 * What KAI gathers itself before the Coach judges a step: the project's own check, run by KAI, and the real diff of the
 * files that changed. Workspace and Learn & Code both review a step this way, so it lives in one place.
 */

/**
 * KAI's own run of the project's check, so the Coach judges a real result and not a guess. It asks first, because the
 * command runs on this computer with the person's permissions, and it says plainly when nothing was run.
 */
export async function collectCheck(projectId: string | null | undefined): Promise<{ check: CheckEvidence | null; notRun?: string }> {
  if (!projectId) return { check: null, notRun: 'no project is open' };
  const overview = await window.kaiDesktop.verificationOverview(projectId);
  const command = overview.ok ? overview.data.suggestedCommand : null;
  if (!command) return { check: null, notRun: 'no test command was found for this project' };
  const allowed = await confirmDialog({
    title: `Run ${command}?`,
    detail: "KAI runs the project's own check so the Coach judges a real result, not a guess. It runs on this computer with your permissions.",
    confirmLabel: 'Run the check',
  });
  if (!allowed) return { check: null, notRun: 'the person chose not to run it' };
  const run = await window.kaiDesktop.runVerification(projectId, command);
  if (!run.ok) return { check: null, notRun: 'the check could not be started' };
  const { command: ran, passed, exitCode, testsPassed, testsFailed, outputTail } = run.data;
  return { check: { command: ran, passed, exitCode, testsPassed, testsFailed, outputTail } };
}

/**
 * The step's real changes. The project's uncommitted files are read, not only what the Builder reported, so a file the
 * person edited by hand is reviewed too. The step's own file comes first, and at most eight are sent.
 */
export async function collectDiffs(projectId: string | null | undefined, where: string, reported: readonly string[]): Promise<Array<{ path: string; diff: string }>> {
  if (!projectId) return [];
  const overview = await window.kaiDesktop.gitOverview(projectId);
  const dirty = overview.ok ? overview.data.changes.map((change) => change.path) : [];
  const stepFile = where.split(':')[0]?.trim() ?? '';
  const paths = [...new Set([...(stepFile && dirty.includes(stepFile) ? [stepFile] : []), ...reported, ...dirty])].slice(0, 8);
  const files: Array<{ path: string; diff: string }> = [];
  for (const path of paths) {
    const working = await window.kaiDesktop.gitDiff(projectId, path, false);
    let diff = working.ok ? working.data.output : '';
    if (!diff.trim()) {
      const staged = await window.kaiDesktop.gitDiff(projectId, path, true);
      diff = staged.ok ? staged.data.output : '';
    }
    files.push({ path, diff });
  }
  return files;
}
