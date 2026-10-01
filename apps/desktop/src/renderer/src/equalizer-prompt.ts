import { sortDifferences, type EqualizerReport } from '@kai/contracts';

/**
 * The prompts the Equalizer hands to an agent once the user has chosen what to fix. The report is read-only: this
 * is the only place its findings become an instruction, and only for the differences the user left ticked.
 */

/** A difference's identity within a report, so a tick survives the list being re-sorted. */
export function differenceKey(screen: string, differenceId: string): string {
  return `${screen}::${differenceId}`;
}

/** Every difference in a report, all selected. */
export function allDifferences(report: EqualizerReport): Set<string> {
  return new Set(report.screens.flatMap((screen) => screen.differences.map((difference) => differenceKey(screen.name, difference.id))));
}

const REFERENCE_WORDS = { 'open-pencil': 'the open-pencil design', website: 'the reference website' } as const;

/** What an agent is told to do about the chosen differences. Returns null when nothing is chosen. */
export function buildFixPrompt(report: EqualizerReport, chosen: ReadonlySet<string>): string | null {
  const sections: string[] = [];
  let count = 0;
  for (const screen of report.screens) {
    const wanted = sortDifferences(screen.differences).filter((difference) => chosen.has(differenceKey(screen.name, difference.id)));
    if (wanted.length === 0) continue;
    count += wanted.length;
    sections.push([`${screen.name}${screen.route ? ` (${screen.route})` : ''}`, ...wanted.map((difference) => `- [${difference.severity}] ${difference.message}`)].join('\n'));
  }
  if (count === 0) return null;

  if (report.target === 'design') {
    return [
      'Use the open-pencil tools to finish the design. The Equalizer checked it against the pages list and found these gaps:',
      '',
      sections.join('\n\n'),
      '',
      'Read pages.md under .kai/spec for what each screen needs, and design/tokens.json and design/style-guide.md for the look. Build each missing screen from the variables and components that already exist, name it exactly as the pages list does, and change nothing else.',
      `The full report is at ${report.reportPath}.`,
      'Stop and tell me if an open-pencil tool call fails; do not retry it in a loop. When you are done, say which screens you drew.',
    ].join('\n');
  }

  const live = report.target === 'production' ? `the production site${report.liveUrl ? ` (${report.liveUrl})` : ''}` : 'the dev server';
  const rounds = Math.max(1, report.rounds - report.round);
  return [
    `Make ${live} match ${REFERENCE_WORDS[report.reference]}${report.referenceUrl ? ` (${report.referenceUrl})` : ''}. The Equalizer compared them and found ${count} difference${count === 1 ? '' : 's'} to fix, worst first:`,
    '',
    sections.join('\n\n'),
    '',
    `The full report, with the reference, live and difference pictures, is at ${report.reportPath}.`,
    report.reference === 'open-pencil' ? 'The design is the source of truth: change the code to match it, never the design.' : 'The reference site is the model to match: change this project to match it, not the other way round.',
    'Use the project\'s design tokens and existing components rather than typing raw values, and change only what the differences above describe.',
    `You have up to ${rounds} attempt${rounds === 1 ? '' : 's'}. After each one, say what you changed. Then stop, so the Equalizer can be run again to measure what is left.`,
  ].join('\n');
}

/** One line for the top of a report: how many screens match, and how many differences remain. */
export function reportSummary(report: EqualizerReport): string {
  const total = report.screens.reduce((sum, screen) => sum + screen.differences.length, 0);
  const matching = report.screens.filter((screen) => screen.status === 'match').length;
  const failed = report.screens.filter((screen) => screen.status === 'error').length;
  const parts = [`${report.screens.length} screen${report.screens.length === 1 ? '' : 's'} checked`, `${matching} match`, `${total} difference${total === 1 ? '' : 's'}`];
  if (failed > 0) parts.push(`${failed} could not be checked`);
  return parts.join(' · ');
}
