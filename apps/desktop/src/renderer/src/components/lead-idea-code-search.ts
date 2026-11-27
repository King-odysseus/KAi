export interface LeadIdeaCodeCandidate {
  path: string;
  size: number;
  content: string;
}

export const LEAD_IDEA_CODE_SCAN_MAX_FILES = 80;
export const LEAD_IDEA_CODE_SCAN_MAX_FILE_BYTES = 64_000;
export const LEAD_IDEA_CODE_SCAN_MAX_BYTES = 1_000_000;

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'idea', 'project', 'please', 'want', 'would', 'could']);

export function leadIdeaTerms(idea: string): string[] {
  return [...new Set((idea.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []).filter((term) => !STOP_WORDS.has(term)))];
}

export function leadIdeaPathScore(path: string, terms: readonly string[]): number {
  const lower = path.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 20 : 0), 0);
}

export function rankRelevantLeadIdeaCode(idea: string, files: readonly LeadIdeaCodeCandidate[]): LeadIdeaCodeCandidate[] {
  const terms = leadIdeaTerms(idea);
  return files.map((file, index) => ({
    file,
    index,
    score: terms.reduce((score, term) => score + (file.content.toLowerCase().includes(term) ? 1 : 0), 0)
      + leadIdeaPathScore(file.path, terms),
  })).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .map((item) => item.file);
}

/** Bound code reads before touching file contents; ties preserve tree order, never alphabetical filename order. */
export function leadIdeaScanCandidates<T extends { path: string; size: number }>(idea: string, files: readonly T[]): T[] {
  const terms = leadIdeaTerms(idea);
  return files.filter((file) => file.size <= LEAD_IDEA_CODE_SCAN_MAX_FILE_BYTES)
    .map((file, index) => ({ file, index, pathScore: leadIdeaPathScore(file.path, terms) }))
    .sort((left, right) => right.pathScore - left.pathScore || left.file.size - right.file.size || left.index - right.index)
    .slice(0, LEAD_IDEA_CODE_SCAN_MAX_FILES)
    .map((item) => item.file);
}
