import type { ChangeReviewResult } from '@kai/contracts';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/**
 * An AI review as Markdown a person can paste into a pull request description or comment. KAI never posts it: what
 * goes onto a shared service is the person's to send, so this only produces the text, with the most serious findings
 * first and anything the second check could not confirm marked as such.
 */
export function reviewToMarkdown(result: ChangeReviewResult): string {
  const lines: string[] = ['## Review notes', ''];
  if (result.summary.trim()) lines.push(result.summary.trim(), '');
  if (result.findings.length === 0) {
    lines.push('No problems found.');
  } else {
    const ordered = [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    for (const finding of ordered) {
      const where = `\`${finding.file}${finding.line ? `:${finding.line}` : ''}\``;
      const unconfirmed = finding.verdict === 'plausible' ? ' _(unconfirmed)_' : '';
      lines.push(`- **${SEVERITY_LABEL[finding.severity]}** ${where}${unconfirmed}: ${finding.note.replace(/\s+/g, ' ').trim()}`);
    }
  }
  const footer: string[] = [];
  if (result.dismissed) footer.push(`${result.dismissed} ${result.dismissed === 1 ? 'finding was' : 'findings were'} dismissed by a second check.`);
  if (result.skippedFiles.length > 0) footer.push(`Not reviewed: ${result.skippedFiles.map((skipped) => `${skipped.file} (${skipped.reason.toLowerCase()})`).join(', ')}.`);
  if (footer.length > 0) lines.push('', ...footer);
  return `${lines.join('\n')}\n`;
}
