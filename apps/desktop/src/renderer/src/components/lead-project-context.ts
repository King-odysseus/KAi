export const LEAD_SPEC_FILES = [
  '.kai/spec/brief.md',
  '.kai/spec/decisions.md',
  '.kai/spec/architecture.md',
  '.kai/spec/status.md',
  '.kai/spec/risks.md',
  '.kai/spec/plan.md',
  '.kai/spec/ideas.md',
  '.kai/spec/board.json',
] as const;

export const LEAD_DESIGN_FILES = ['DESIGN.md', 'design.md'] as const;

/** Avoid sending a similarly named backend design note (for example, "database design") as visual guidance. */
export function isLeadUiRequest(question: string): boolean {
  return /\b(?:ui|user interface|screen|page|component|button|layout|stylesheet|css|frontend|front-end|visual|responsive|colour|color|typography|spacing|navigation|sidebar|form field)\b/i.test(question);
}

export interface LeadSpecFile {
  path: string;
  content: string;
}

export const LEAD_PROMPT_LIMIT = 20_000;
const DEFAULT_BUDGET = 16_000;

function markdownSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    const heading = !fence && /^#{1,3}\s/.test(line);
    if (heading && current.length) { sections.push(current.join('\n')); current = []; }
    current.push(line);
    if (mark && !fence) fence = mark;
    else if (mark && fence && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
  }
  if (current.length) sections.push(current.join('\n'));
  return sections;
}

function sourceSections(path: string, text: string): string[] {
  if (/\.(?:md|mdx|markdown)$/i.test(path)) return markdownSections(text);
  // Keep imports as one unit and split source files only at top-level declarations; these boundaries
  // avoid sending a partial function, class, interface or type when a file is over budget.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const starts: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (mark && !fence) fence = mark;
    else if (mark && fence && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    if (fence || !/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+/.test(line)) return;
    starts.push(index);
  });
  if (starts.length === 0) return [lines.join('\n')];
  const sections: string[] = [];
  if (starts[0]! > 0) sections.push(lines.slice(0, starts[0]).join('\n'));
  for (let i = 0; i < starts.length; i += 1) sections.push(lines.slice(starts[i]!, starts[i + 1] ?? lines.length).join('\n'));
  return sections;
}

function chooseContext(files: readonly LeadSpecFile[], question: string, budget: number): { text: string; included: string[]; omitted: string[] } {
  const terms = new Set((question.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []).filter((term) => !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(term)));
  const sections: Array<{ path: string; heading: string; body: string; score: number; order: number; relevant: boolean }> = [];
  let order = 0;
  for (const file of files) {
    const chunks = sourceSections(file.path, file.content);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const firstLine = chunk.split('\n', 1)[0]?.trim() ?? '';
      const score = [...terms].reduce((total, term) => total + (chunk.toLowerCase().includes(term) ? 12 : 0), 0);
      const designFile = /(?:^|\/)design\.md$/i.test(file.path);
      const priority = designFile ? 30 : /brief\.md$/i.test(file.path) ? 20 : /status\.md$/i.test(file.path) ? 12 : /decisions\.md$|architecture\.md$|risks\.md$|plan\.md$|ideas\.md$|board\.json$/i.test(file.path) ? 10 : 0;
      sections.push({ path: file.path, heading: firstLine.startsWith('#') ? firstLine : firstLine.slice(0, 100) || '(file content)', body: chunk.trim(), score: priority + score, order: order++, relevant: designFile ? score > 0 : Boolean(priority || score) });
    }
  }
  const ranked = sections.filter((section) => section.relevant).sort((a, b) => b.score - a.score || a.order - b.order);
  const kept = new Set<typeof sections[number]>();
  for (const section of ranked) {
    const nextContent = [...kept, section].map((candidate) => `### ${candidate.path} — ${candidate.heading}\n${candidate.body}`).join('\n\n');
    if (nextContent.length <= budget) kept.add(section);
  }
  const orderedKept = sections.filter((section) => kept.has(section));
  const omitted = sections.filter((section) => !kept.has(section));
  const content = orderedKept.map((section) => `### ${section.path} — ${section.heading}\n${section.body}`).join('\n\n');
  const grouped = new Map<string, number>();
  for (const section of omitted) grouped.set(section.path, (grouped.get(section.path) ?? 0) + 1);
  const detailNote = omitted.length
    ? `Sections omitted to fit the request: ${omitted.map((item) => `${item.path} — ${item.heading}`).join('; ')}.`
    : '';
  const groupedNote = omitted.length
    ? `Sections omitted to fit the request: ${[...grouped].map(([path, count]) => `${count} sections in ${path}`).join('; ')}.`
    : '';
  let boundedNote = detailNote.length + content.length + (content && detailNote ? 2 : 0) <= budget ? detailNote : groupedNote;
  if (boundedNote.length + content.length + (content && boundedNote ? 2 : 0) > budget) boundedNote = omitted.length && budget >= 22 ? `Sections omitted: ${omitted.length}.` : '';
  const trimmedContent = boundedNote && content.length + boundedNote.length + 2 > budget ? '' : content;
  return {
    text: [trimmedContent, boundedNote].filter(Boolean).join('\n\n'),
    included: [...new Set(orderedKept.map((section) => section.path))],
    omitted: [...new Set(omitted.map((section) => `${section.path} — ${section.heading}`))],
  };
}

/** Selects whole Markdown sections from the Studio handoff files; it never cuts through a code fence. */
export function buildLeadSpecContext(files: readonly LeadSpecFile[], question: string, budget = DEFAULT_BUDGET): { text: string; included: string[]; omitted: string[] } {
  return chooseContext(files, question, budget);
}

export function buildLeadRequestText(input: {
  question: string;
  specFiles: readonly LeadSpecFile[];
  openFile?: LeadSpecFile;
  openFiles?: readonly LeadSpecFile[];
  contextNotes?: readonly string[];
  includeProjectOrientation: boolean;
  style: 'tutor' | 'senior-dev';
  detail: 'brief' | 'step-by-step' | 'line-by-line';
  questions: 'blocked' | 'decisions' | 'each-step';
  leadCoachPrompt: (message: string, style: 'tutor' | 'senior-dev', detail: 'brief' | 'step-by-step' | 'line-by-line', questions: 'blocked' | 'decisions' | 'each-step') => string;
}): { prompt: string; displayText: string; included: string[]; omitted: string[] } {
  const orientation = input.includeProjectOrientation
    ? 'Begin by stating the project goal and next useful step based on available project context. Keep project files unchanged. For authentication, permissions, payments, migrations, or deleting data, flag the risk and ask for approval before suggesting the change.'
    : 'Keep project files unchanged. For authentication, permissions, payments, migrations, or deleting data, flag the risk and ask for approval before suggesting the change.';
  const wrappedQuestion = input.leadCoachPrompt('', input.style, input.detail, input.questions).length;
  const separators = 6;
  const contextPrefix = 'Project context (read only):\n';
  const notesText = (input.contextNotes ?? []).join('\n');
  const contextBudget = Math.max(0, LEAD_PROMPT_LIMIT - wrappedQuestion - input.question.length - orientation.length - notesText.length - separators - contextPrefix.length);
  const contextFiles = [
    ...input.specFiles,
    ...(input.openFiles ?? []),
    ...(input.openFile ? [input.openFile] : []),
  ];
  const context = chooseContext(contextFiles, input.question, contextBudget);
  const contextText = context.text ? `${contextPrefix}${context.text}` : '';
  const message = [input.question, contextText, notesText, orientation].filter(Boolean).join('\n\n');
  const prompt = input.leadCoachPrompt(message, input.style, input.detail, input.questions);
  if (prompt.length > LEAD_PROMPT_LIMIT) throw new Error('Lead request exceeds the 20,000 character limit; reduce the question length.');
  return { prompt, displayText: input.question, included: context.included, omitted: context.omitted };
}
