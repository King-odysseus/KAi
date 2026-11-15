/**
 * A crew's name for a list. The goal is whatever the person typed, and it is often a long file path ("C:\...\plan.md
 * implement this plan"), so clipping it showed the same unreadable prefix for every crew on that plan. A path, quoted
 * or not, is reduced to its file name before the text is clipped.
 */
export function crewTitle(goal: string): string {
  const flat = goal.replace(/\s+/g, ' ').trim();
  const named = flat.replace(/"([^"]*[\\/][^"]*)"|((?:[A-Za-z]:)?[\\/][^\s"]*[\\/][^\s"]+)/g, (match, quoted: string | undefined, bare: string | undefined) => {
    const path = quoted ?? bare ?? match;
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? match;
  });
  const clipped = named.length > 60 ? `${named.slice(0, 59).trimEnd()}…` : named;
  return clipped || 'Untitled crew';
}
