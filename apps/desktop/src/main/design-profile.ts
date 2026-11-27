import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ts from 'typescript';
import { designProfileSummarySchema, type DesignProfileSummary } from '@kai/contracts';
import { listProjectFiles } from './repo-map';
import { resolveInside } from './project-files';
import type { SpecStore } from './spec-store';

export const DESIGN_PROFILE_MARKER = '<!-- kai:design-profile -->';
export const PROFILE_DELIVERY_BUDGET = 6_000;
const PROFILE_PATH = 'design/profile.md';
const MAX_FILES = 1_500;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_DESIGN_FILE_BYTES = PROFILE_DELIVERY_BUDGET * 8;
const MAX_ROOT_DESIGN_BYTES = 512 * 1024;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const COMPONENTS = [
  { key: 'button', label: 'Button', matches: /<(?:button|Button)\b|class(?:Name)?\s*=\s*["'`][^"'`]*\b(?:btn|button)\b[^"'`]*["'`]/i },
  { key: 'card', label: 'Card', matches: /<Card\b|class(?:Name)?\s*=\s*["'`][^"'`]*\b(?:card|panel|surface)\b[^"'`]*["'`]/i },
  { key: 'field', label: 'Form field', matches: /<(?:input|textarea|select|form|Input)\b/i },
  { key: 'page-header', label: 'Page header', matches: /<(?:header|h1)\b/i },
] as const;

interface PickState {
  version: 1;
  picks: Record<string, Record<string, string>>;
}

interface ComponentEvidence {
  key: string;
  label: string;
  exportName: string;
  source: string;
  code: string;
  uses: number;
  projects: number;
  recency: number;
  picks: number;
  score: number;
}

interface ProjectEvidence {
  name: string;
  root: string;
  files: Array<{ relative: string; text: string; mtime: number }>;
  tailwind: string[];
  variables: Array<{ key: string; value: string }>;
  sharedClasses: Array<{ name: string; count: number; declarations: string }>;
  components: ComponentEvidence[];
  studioReferences: string[];
  differences: string[];
}

export interface DesignProfilePorts {
  projects(): Promise<Array<{ id: string; name: string; path: string }>>;
  now?(): number;
}

function emptyPicks(): PickState {
  return { version: 1, picks: {} };
}

function displayStatus(markdown: string | null): DesignProfileSummary['status'] {
  if (!markdown?.startsWith(DESIGN_PROFILE_MARKER)) return markdown ? 'user-owned' : 'missing';
  return /^Status:\s*Approved\s*$/im.test(markdown) ? 'approved' : 'draft';
}

function flattenStrings(value: unknown, prefix = ''): Array<{ key: string; value: string }> {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ key: prefix, value: String(value) }];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => flattenStrings(entry, `${prefix}[${index}]`));
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => flattenStrings(entry, prefix ? `${prefix}.${key}` : key));
  return [];
}

function extractTheme(source: string): string[] {
  const start = /theme\s*:\s*\{/g;
  const sections: string[] = [];
  for (const match of source.matchAll(start)) {
    const open = source.indexOf('{', match.index ?? 0);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}' && --depth === 0) break;
    }
    if (end > open) sections.push(source.slice(open + 1, Math.min(end, open + 1_200)).replace(/\s+/g, ' ').trim());
  }
  return sections;
}

function rootVariables(source: string): Array<{ key: string; value: string }> {
  const values = new Map<string, string>();
  for (const block of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|,)\s*(?::root|html|body)(?:\b|$)/i.test(block[1]!.trim())) continue;
    for (const match of (block[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) values.set(match[1]!, match[2]!.trim());
  }
  return [...values].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
}

function sharedClasses(styles: readonly { text: string }[]): ProjectEvidence['sharedClasses'] {
  const records = new Map<string, { count: number; declarations: Set<string> }>();
  for (const file of styles) {
    const css = file.text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = (match[2] ?? '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      for (const classMatch of (match[1] ?? '').matchAll(/\.([\w-]+)/g)) {
        const name = classMatch[1]!;
        if (!/(?:btn|button|card|form|field|input|header|title)/i.test(name)) continue;
        const item = records.get(name) ?? { count: 0, declarations: new Set<string>() };
        item.count += 1;
        item.declarations.add(body.slice(0, 300));
        records.set(name, item);
      }
    }
  }
  return [...records]
    .filter(([, item]) => item.count > 1)
    .map(([name, item]) => ({ name, count: item.count, declarations: [...item.declarations].join(' | ').slice(0, 400) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 60);
}

function sourceFile(text: string, filePath: string): ts.SourceFile {
  const extension = path.extname(filePath).toLowerCase();
  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
}

function hasJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found) found = hasJsx(child); });
  return found;
}

function exportedUiComponents(text: string, filePath: string): Array<{ name: string; code: string }> {
  const ast = sourceFile(text, filePath);
  const components: Array<{ name: string; code: string }> = [];
  for (const statement of ast.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));
    if (!exported) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && hasJsx(statement)) components.push({ name: statement.name.text, code: statement.getText(ast) });
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && hasJsx(declaration.initializer)) components.push({ name: declaration.name.text, code: statement.getText(ast) });
      }
    }
  }
  return [...new Map(components.map((component) => [component.name, component])).values()];
}

function matchesComponent(component: { name: string; code: string }, key: string): boolean {
  const root = /(?:return\s*\(?\s*|=>\s*)<([A-Za-z][\w.]*)\b/.exec(component.code)?.[1]?.toLowerCase() ?? '';
  if (key === 'button') return /button/i.test(component.name) || (root === 'button' && !/(?:row|select|field|group|trigger|menu|dropdown)/i.test(component.name));
  if (key === 'card') return /(?:card|panel|surface)/i.test(component.name) || /class(?:Name)?\s*=\s*["'`][^"'`]*\bcard\b/i.test(component.code);
  if (key === 'field') return /(?:input|field|form)/i.test(component.name) || ['input', 'textarea', 'select', 'form'].includes(root);
  return /header/i.test(component.name) || ['header', 'h1'].includes(root);
}

function candidateMatches(relative: string, components: Array<{ name: string; code: string }>, key: string, _matcher: RegExp): boolean {
  const parts = relative.toLowerCase().split(/[\\/]/);
  if (parts.some((part) => ['pages', 'routes', 'screens', 'views'].includes(part))) return false;
  return components.some((component) => !/(?:hero|banner|section|page|screen|layout|view)$/i.test(component.name)
    && matchesComponent(component, key));
}

function indexComponentUses(files: ProjectEvidence['files']): Map<string, Map<string, number>> {
  const byFile = new Map<string, Map<string, number>>();
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file.relative).toLowerCase())) continue;
    const ast = sourceFile(file.text, file.relative);
    const exportsByAlias = new Map<string, Set<string>>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
      const moduleName = statement.moduleSpecifier.text.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase() ?? '';
      const add = (alias: string, exportName: string): void => {
        const exports = exportsByAlias.get(alias) ?? new Set<string>();
        exports.add(exportName);
        exportsByAlias.set(alias, exports);
      };
      if (statement.importClause.name) add(statement.importClause.name.text, moduleName);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) add(element.name.text, element.propertyName?.text ?? element.name.text);
    }
    const counts = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        for (const exportName of exportsByAlias.get(node.tagName.text) ?? []) counts.set(exportName, (counts.get(exportName) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    byFile.set(file.relative, counts);
  }
  return byFile;
}

function studioDifferences(guide: string | null, tokens: string | null, variables: ProjectEvidence['variables']): string[] {
  const lines: string[] = [];
  if (guide) {
    const relevant = guide.split(/\r?\n/).filter((line) => /button|card|field|header|radius|rounded|border|shadow|color|colour|spacing/i.test(line)).slice(0, 20);
    if (relevant.length) lines.push(`style-guide.md notes: ${relevant.join(' | ')}`);
  }
  if (tokens) {
    try {
      const parsed = JSON.parse(tokens) as unknown;
      const tokenValues = flattenStrings(parsed);
      const byKey = new Map(tokenValues.map((item) => [item.key.toLowerCase().replace(/[^a-z0-9]/g, ''), item.value]));
      for (const variable of variables) {
        const key = variable.key.replace(/^--/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const studioValue = byKey.get(key);
        if (studioValue !== undefined && studioValue !== variable.value) lines.push(`${variable.key}: code is ${variable.value}; tokens.json is ${studioValue}`);
      }
      if (tokenValues.length && !lines.some((line) => line.includes('tokens.json'))) {
        lines.push(`tokens.json exists (${tokenValues.length} values); no matching CSS variable names were found for direct comparison.`);
      }
    } catch {
      lines.push('tokens.json exists but is not valid JSON; values could not be compared.');
    }
  }
  return lines;
}

function renderProfile(evidence: ProjectEvidence, status: 'Draft' | 'Approved'): string {
  const lines = [
    DESIGN_PROFILE_MARKER,
    '# Design profile',
    `Status: ${status}`,
    '',
    `Generated from code in ${evidence.name}. Scores are computed by KAI, not written by a model.`,
    '',
    '## Tailwind theme settings',
    ...(evidence.tailwind.length ? evidence.tailwind.map((item) => `- ${item}`) : ['- No readable Tailwind theme settings found.']),
    '',
    '## CSS variables',
    ...(evidence.variables.length ? evidence.variables.map((item) => `- ${item.key}: ${item.value}`) : ['- No root CSS variables found.']),
    '',
    '## Shared component classes',
    ...(evidence.sharedClasses.length ? evidence.sharedClasses.map((item) => `- .${item.name} (${item.count} rules): ${item.declarations}`) : ['- No repeated button, card, field, or header classes found.']),
    '',
    '## Component evidence and score',
    'Score = uses x 3 + projects x 20 + recency / 10 + developer picks x 50. Recency is a 0-100 code-derived score based on source-file modification time.',
    '',
  ];
  for (const definition of COMPONENTS) {
    const component = evidence.components.find((item) => item.key === definition.key);
    if (!component) {
      lines.push(`### ${definition.label}`, 'Component: none found', '');
      continue;
    }
    lines.push(
      `### ${component.label}`,
      `Source: \`${component.source}\``,
      `Score: ${component.score} (uses ${component.uses}, projects ${component.projects}, recency ${component.recency}, developer picks ${component.picks})`,
      '',
      '```tsx',
      component.code,
      '```',
      '',
    );
  }
  if (evidence.studioReferences.length || evidence.differences.length) {
    lines.push('## Existing Studio files to compare', ...evidence.studioReferences.map((file) => `- ${file} is present and was not replaced.`), ...evidence.differences.map((line) => `- ${line}`), '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export function isUiRequest(prompt: string, selectedPaths: readonly string[]): boolean {
  const uiWords = /\b(ui|user interface|screen|page|component|button|card|form|field|layout|styling|style|css|tailwind|dashboard|front[- ]?end|visual|navigation|navbar|sidebar|modal|dialog|website|webpage)\b/i;
  const namedUiDesign = /\b(?:design|redesign|restyle)\s+(?:the\s+)?(?:ui|interface|screen|page|component|button|card|form|layout|dashboard|website|webpage|navigation|navbar|sidebar|modal|dialog)\b/i;
  return selectedPaths.some((file) => /\.(?:tsx|jsx|css|scss|sass|less)$/i.test(file)) || uiWords.test(prompt) || namedUiDesign.test(prompt);
}

function boundedMarkdown(text: string, budget: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const chunks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const chunk: string[] = [];
    const fenced = /^\s*(```|~~~)/.test(lines[index] ?? '');
    const fence = fenced ? (lines[index]!.match(/^\s*(```|~~~)/)![1]!) : null;
    chunk.push(lines[index++] ?? '');
    if (fence) {
      let closed = false;
      while (index < lines.length) {
        const line = lines[index++] ?? '';
        chunk.push(line);
        if (new RegExp(`^\\s*${fence}\\s*$`).test(line)) { closed = true; break; }
      }
      if (!closed) continue;
    }
    const value = chunk.join('\n');
    if (chunks.join('\n').length + value.length + 1 > budget) {
      if (!fence && value.length < 400 && chunks.join('\n').length + value.length + 1 <= budget) chunks.push(value);
      break;
    }
    chunks.push(value);
  }
  return chunks.join('\n').trim();
}

export function selectRelevantDesignSections(text: string, prompt: string, budget: number): { included: string[]; omitted: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ title: string; level: number; lines: string[]; index: number }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading || heading[1]!.length > 2) continue;
    sections.push({ title: heading[2]!, level: heading[1]!.length, lines: [], index });
  }
  if (!sections.length) sections.push({ title: 'Introduction', level: 1, lines: [...lines], index: 0 });
  else {
    if (sections[0]!.index > 0) sections.unshift({ title: 'Introduction', level: 1, lines: lines.slice(0, sections[0]!.index), index: 0 });
    for (const [position, section] of sections.entries()) {
      const next = sections.slice(position + 1).find((candidate) => candidate.level <= section.level);
      section.lines = lines.slice(section.index, next?.index ?? lines.length);
    }
  }
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'make', 'build', 'style', 'design', 'please', 'should', 'using', 'use', 'page', 'component', 'ui']);
  const queryWords = [...new Set((prompt.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((word) => !stop.has(word)))];
  const expansions: Record<string, string[]> = {
    button: ['buttons', 'action', 'actions', 'control'],
    card: ['cards', 'panel', 'surface'],
    form: ['forms', 'field', 'input', 'validation'],
    dashboard: ['dashboard', 'data', 'chart', 'metric'],
    navigation: ['navigation', 'nav', 'sidebar', 'menu'],
    pricing: ['pricing', 'price', 'plans', 'billing'],
    layout: ['layout', 'spacing', 'grid', 'responsive'],
    color: ['color', 'colour', 'palette', 'theme'],
    typography: ['type', 'font', 'typography', 'heading'],
  };
  const terms = [...new Set([...queryWords, ...queryWords.flatMap((word) => expansions[word] ?? [])])];
  const ranked = sections.map((section, index) => {
    const content = section.lines.join('\n');
    const heading = section.title.toLowerCase();
    const score = terms.reduce((sum, word) => sum + (heading.includes(word) ? 5 : 0) + (content.toLowerCase().match(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'g'))?.length ?? 0), 0);
    return { ...section, content, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof ranked = [];
  let used = 0;
  for (const section of ranked) {
    if (section.score === 0) continue;
    const chunk = section.content.trim();
    if (!chunk || used + chunk.length + (chosen.length ? 2 : 0) > budget) continue;
    chosen.push(section);
    used += chunk.length + (chosen.length > 1 ? 2 : 0);
  }
  if (!chosen.length && ranked.length) {
    const fallback = ranked.find((section) => section.content.trim().length <= budget);
    if (fallback) chosen.push(fallback);
  }
  const included = chosen.sort((a, b) => a.index - b.index).map((section) => section.content.trim());
  const selectedTitles = new Set(chosen.map((section) => section.title));
  const omitted = sections.filter((section) => !selectedTitles.has(section.title)).map((section) => section.title);
  return { included, omitted };
}

async function readRootDesign(projectRoot: string): Promise<{ path: string; text: string; unreadBytes: boolean } | null> {
  for (const relative of ['DESIGN.md', 'design.md']) {
    const full = await resolveInside(projectRoot, relative);
    try {
      const stat = await fs.stat(full);
      const handle = await fs.open(full, 'r');
      try {
        const buffer = Buffer.alloc(MAX_ROOT_DESIGN_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        if (text.trim()) return { path: relative, text, unreadBytes: stat.size > bytesRead };
      } finally { await handle.close(); }
    } catch { /* This spelling is absent or unreadable; try the other case. */ }
  }
  return null;
}

export class DesignProfileService {
  private summaries: DesignProfileSummary[] = [];
  private evidenceByPath = new Map<string, ProjectEvidence>();
  private refreshing: Promise<DesignProfileSummary[]> | null = null;

  constructor(private readonly picksPath: string, private readonly spec: SpecStore, private readonly ports: DesignProfilePorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private async loadPicks(): Promise<PickState> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.picksPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'picks' in parsed && typeof parsed.picks === 'object') return parsed as PickState;
    } catch { /* A missing or invalid preference file starts with no developer picks. */ }
    return emptyPicks();
  }

  async refresh(): Promise<DesignProfileSummary[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.rebuild().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async rebuild(): Promise<DesignProfileSummary[]> {
    const projects = await this.ports.projects();
    const picks = await this.loadPicks();
    const evidence = await Promise.all(projects.map((project) => this.readProject(project)));
    for (const item of evidence) {
      for (const component of item.components) {
        component.projects = new Set(evidence.filter((other) => other.components.some((candidate) => candidate.key === component.key)).map((other) => path.resolve(other.root))).size;
        component.picks = Object.values(picks.picks).filter((projectPicks) => path.resolve(projectPicks[component.key] ?? '') === path.resolve(item.root)).length;
        component.score = component.uses * 3 + component.projects * 20 + component.recency / 10 + component.picks * 50;
      }
    }
    const summaries: DesignProfileSummary[] = [];
    this.evidenceByPath.clear();
    for (const item of evidence) {
      this.evidenceByPath.set(path.resolve(item.root), item);
      const existing = await this.spec.read(item.root, PROFILE_PATH);
      if (existing && !existing.startsWith(DESIGN_PROFILE_MARKER)) {
        summaries.push(designProfileSummarySchema.parse({ projectId: projects.find((project) => path.resolve(project.path) === path.resolve(item.root))?.id ?? item.name, projectName: item.name, projectPath: item.root, status: 'user-owned', componentCount: item.components.length, components: item.components.map(({ key, label, source, uses, projects: count, score }) => ({ key, label, source, uses, projects: count, score })), score: Math.round(item.components.reduce((sum, component) => sum + component.score, 0)), updatedAt: null, agentsPasteLine: `See .kai/spec/design/profile.md for the approved design profile of ${item.name}.` }));
        continue;
      }
      const status = displayStatus(existing);
      const agentsPath = await resolveInside(item.root, 'AGENTS.md');
      const agents = await fs.readFile(agentsPath, 'utf8').catch(() => null);
      const pasteLine = agents?.startsWith('<!-- kai:agents -->') ? null : `See .kai/spec/design/profile.md for the approved design profile of ${item.name}.`;
      summaries.push(designProfileSummarySchema.parse({
        projectId: projects.find((project) => project.path === item.root)?.id ?? item.name,
        projectName: item.name,
        projectPath: item.root,
        status,
        componentCount: item.components.length,
        components: item.components.map(({ key, label, source, uses, projects: count, score }) => ({ key, label, source, uses, projects: count, score })),
        score: Math.round(item.components.reduce((sum, component) => sum + component.score, 0)),
        updatedAt: null,
        agentsPasteLine: pasteLine,
      }));
    }
    this.summaries = summaries;
    return [...summaries];
  }

  async state(refresh = false): Promise<DesignProfileSummary[]> {
    if (refresh || this.summaries.length === 0) return this.refresh();
    return [...this.summaries];
  }

  async generateDraft(projectPath: string): Promise<DesignProfileSummary> {
    const project = (await this.ports.projects()).find((candidate) => path.resolve(candidate.path) === path.resolve(projectPath));
    if (!project) throw new Error('That project is no longer open in KAI.');
    const existing = await this.spec.read(project.path, PROFILE_PATH);
    if (existing && !existing.startsWith(DESIGN_PROFILE_MARKER)) throw new Error('This profile is user-owned, so KAI will not overwrite it.');
    if (!this.evidenceByPath.has(path.resolve(project.path))) await this.refresh();
    const evidence = this.evidenceByPath.get(path.resolve(project.path));
    if (!evidence) throw new Error('No profile evidence could be read for this project.');
    await this.spec.write(project.path, PROFILE_PATH, renderProfile(evidence, 'Draft'));
    await this.refresh();
    const summary = this.summaries.find((item) => path.resolve(item.projectPath) === path.resolve(project.path));
    if (!summary) throw new Error('The draft profile could not be reloaded.');
    return summary;
  }

  async approve(projectPath: string): Promise<DesignProfileSummary> {
    const project = (await this.ports.projects()).find((candidate) => path.resolve(candidate.path) === path.resolve(projectPath));
    if (!project) throw new Error('That project is no longer open in KAI.');
    const current = await this.spec.read(project.path, PROFILE_PATH);
    if (!current?.startsWith(DESIGN_PROFILE_MARKER)) throw new Error('This profile is missing or user-owned, so KAI will not overwrite it.');
    const alreadyApproved = /^Status:\s*Approved\s*$/im.test(current);
    const approved = current.replace(/^Status:\s*Draft\s*$/im, 'Status: Approved');
    if (!alreadyApproved && approved === current) throw new Error('The profile status could not be updated.');
    if (!alreadyApproved) await this.spec.write(project.path, PROFILE_PATH, approved);
    const line = `See .kai/spec/design/profile.md for the approved design profile of ${project.name}.`;
    const designPath = await resolveInside(project.path, 'DESIGN.md');
    const design = await fs.readFile(designPath, 'utf8').catch(() => null);
    if (design === null || design.startsWith(DESIGN_PROFILE_MARKER)) {
      const content = `${DESIGN_PROFILE_MARKER}\n# Design guidance\n\n${line}\n`;
      if (design !== content) await fs.writeFile(designPath, content, 'utf8');
    }
    const agentsPath = await resolveInside(project.path, 'AGENTS.md');
    const agents = await fs.readFile(agentsPath, 'utf8').catch(() => null);
    if (agents?.startsWith('<!-- kai:agents -->') && !agents.includes(line)) await fs.writeFile(agentsPath, `${agents.trimEnd()}\n\n${line}\n`, 'utf8');
    await this.refresh();
    const summary = this.summaries.find((item) => path.resolve(item.projectPath) === path.resolve(project.path));
    if (!summary) throw new Error('The approved profile could not be reloaded.');
    return summary;
  }

  async briefing(projectRoot: string, prompt: string, selectedPaths: readonly string[] = []): Promise<string> {
    if (!isUiRequest(prompt, selectedPaths)) return '';
    const rootDesign = await readRootDesign(projectRoot);
    const developerDesign = rootDesign && !rootDesign.text.startsWith(DESIGN_PROFILE_MARKER) ? rootDesign : null;
    let approved = await this.spec.read(projectRoot, PROFILE_PATH);
    if (!this.evidenceByPath.has(path.resolve(projectRoot))) {
      await this.refresh();
      approved = await this.spec.read(projectRoot, PROFILE_PATH);
    }
    const hasApprovedProfile = Boolean(approved?.startsWith(DESIGN_PROFILE_MARKER) && displayStatus(approved) === 'approved');
    if (!developerDesign && !hasApprovedProfile) return '';
    const evidence = this.evidenceByPath.get(path.resolve(projectRoot));
    if (!evidence && !developerDesign) return '';
    const component = (key: string) => evidence?.components.find((item) => item.key === key);
    const promptKey = /\b(button|card|form field|input|field|page header|header)\b/i.exec(prompt)?.[1]?.toLowerCase();
    const selected = selectedPaths.join(' ').toLowerCase();
    const relevantKeys = promptKey
      ? [promptKey.includes('button') ? 'button' : promptKey.includes('card') ? 'card' : promptKey.includes('header') ? 'page-header' : 'field']
      : selected.includes('button') ? ['button'] : selected.includes('card') ? ['card'] : selected.match(/field|input/) ? ['field'] : selected.match(/header/) ? ['page-header'] : ['button', 'card', 'field', 'page-header'];
    let result = '';
    if (developerDesign) {
      const excerpt = boundedMarkdown(developerDesign.text, PROFILE_DELIVERY_BUDGET - 500);
      result = `## Existing ${developerDesign.path} (highest priority)\nFollow this project's authored design guidance first. If it conflicts with KAI's generated profile, follow this file.\n\n${excerpt}`;
    }
    if (!hasApprovedProfile || !evidence) return result;
    const profileHeading = `${result ? '\n\n' : ''}## Approved generated profile (secondary)\nUse the existing project design guidance above when it differs.`;
    const blocks = relevantKeys.map((key) => ({ key, item: component(key) }));
    const initial = result + profileHeading;
    result = initial;
    for (const { key, item } of blocks) {
      const definition = COMPONENTS.find((candidate) => candidate.key === key)!;
      if (!item) {
        const missing = `\n\n### ${definition.label}\nComponent: none found`;
        if (result.length + missing.length <= PROFILE_DELIVERY_BUDGET) result += missing;
        continue;
      }
      const snippet = ['', `### ${item.label} from ${item.source}`, '```tsx', item.code, '```'].join('\n');
      if (result.length + snippet.length > PROFILE_DELIVERY_BUDGET) continue;
      result += snippet;
    }
    if (result === initial && blocks.some(({ item }) => item)) {
      const note = '\n\nNo complete reusable component snippet fits within the remaining context budget.';
      if (result.length + note.length <= PROFILE_DELIVERY_BUDGET) result += note;
    }
    const facts = [
      ...(evidence.variables.length ? [`CSS variables: ${evidence.variables.slice(0, 24).map((item) => `${item.key}: ${item.value}`).join('; ')}`] : []),
      ...(evidence.sharedClasses.length ? [`Shared classes: ${evidence.sharedClasses.slice(0, 20).map((item) => `.${item.name}`).join(', ')}`] : []),
    ];
    for (const fact of facts) if (result.length + fact.length + 2 <= PROFILE_DELIVERY_BUDGET) result += `\n\n${fact}`;
    return result;
  }

  async recordPick(projectRoot: string, component: string, sourceProjectRoot: string): Promise<void> {
    const state = await this.loadPicks();
    const project = path.resolve(projectRoot);
    const picks = { ...state.picks, [project]: { ...(state.picks[project] ?? {}), [component]: path.resolve(sourceProjectRoot) } };
    await fs.mkdir(path.dirname(this.picksPath), { recursive: true });
    const temporary = `${this.picksPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ version: 1, picks }), 'utf8');
    await fs.rename(temporary, this.picksPath);
  }

  private async readProject(project: { id: string; name: string; path: string }): Promise<ProjectEvidence> {
    const listed = (await listProjectFiles(project.path)).filter((relative) => {
      const ext = path.extname(relative).toLowerCase();
      return SOURCE_EXTENSIONS.has(ext) || STYLE_EXTENSIONS.has(ext) || ['package.json', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.ts', 'tailwind.config.mjs'].includes(path.basename(relative).toLowerCase());
    }).slice(0, MAX_FILES);
    const files: ProjectEvidence['files'] = [];
    for (const relative of listed) {
      try {
        const full = await resolveInside(project.path, relative);
        const stat = await fs.lstat(full);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        files.push({ relative: relative.replace(/\\/g, '/'), text: await fs.readFile(full, 'utf8'), mtime: stat.mtimeMs });
      } catch { /* Unreadable or generated project files are not profile evidence. */ }
    }
    const styles = files.filter((file) => STYLE_EXTENSIONS.has(path.extname(file.relative).toLowerCase()));
    const variables = [...new Map(styles.flatMap((file) => rootVariables(file.text)).map((item) => [item.key, item])).values()]
      .sort((a, b) => a.key.localeCompare(b.key)).slice(0, 100);
    const tailwind = files
      .filter((file) => /tailwind\.config\.[cm]?[jt]s$/i.test(file.relative))
      .flatMap((file) => extractTheme(file.text).map((item) => `${file.relative}: ${item}`))
      .slice(0, 20);
    const shared = sharedClasses(styles);
    const now = this.now();
    const components: ComponentEvidence[] = [];
    const componentUses = indexComponentUses(files);
    const totalComponentUses = new Map<string, number>();
    for (const counts of componentUses.values()) for (const [name, count] of counts) totalComponentUses.set(name, (totalComponentUses.get(name) ?? 0) + count);
    const componentsByFile = new Map(files.map((file) => [file.relative, exportedUiComponents(file.text, file.relative)]));
    for (const definition of COMPONENTS) {
      const candidates = files
        .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file.relative).toLowerCase()) && candidateMatches(file.relative, componentsByFile.get(file.relative) ?? [], definition.key, definition.matches))
        .flatMap((file) => (componentsByFile.get(file.relative) ?? [])
          .filter((component) => matchesComponent(component, definition.key))
          .map((component) => ({ file, component, uses: (totalComponentUses.get(component.name) ?? 0) - (componentUses.get(file.relative)?.get(component.name) ?? 0) })))
        .filter((item) => item.uses >= (definition.key === 'page-header' ? 2 : 1))
        .sort((a, b) => b.uses - a.uses || b.file.mtime - a.file.mtime || a.file.relative.localeCompare(b.file.relative));
      const candidate = candidates[0];
      if (!candidate) continue;
      const { file, component, uses } = candidate;
      const ageDays = Math.max(0, (now - file.mtime) / 86_400_000);
      const recency = Math.max(0, Math.round(100 - ageDays / 365 * 100));
      components.push({ key: definition.key, label: definition.label, exportName: component.name, source: file.relative, code: component.code.trim(), uses, projects: 1, recency, picks: 0, score: uses * 3 + recency / 10 });
    }
    const guide = await this.spec.read(project.path, 'design/style-guide.md');
    const tokens = await this.spec.read(project.path, 'design/tokens.json');
    const studioReferences = [guide ? '.kai/spec/design/style-guide.md' : '', tokens ? '.kai/spec/design/tokens.json' : ''].filter(Boolean);
    return { name: project.name, root: project.path, files, tailwind, variables, sharedClasses: shared, components, studioReferences, differences: studioDifferences(guide, tokens, variables) };
  }
}
