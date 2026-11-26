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
const TARGET_NAMES = new Set(['zurilofts', 'tijhawebsite', 'tijhabooks']);
const MAX_FILES = 1_500;
const MAX_FILE_BYTES = 200 * 1024;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function componentCandidateScore(relative: string, text: string, key: string, matcher: RegExp): number {
  const base = path.basename(relative, path.extname(relative)).toLowerCase().replace(/[^a-z0-9]/g, '');
  const componentMatch = key === 'button' ? /(?:button|btn)$/.test(base)
    : key === 'card' ? /(?:card|panel|surface)$/.test(base)
      : key === 'field' ? /(?:formfield|textfield|input|field)$/.test(base)
        : /(?:pageheader|sectionheader|header)$/.test(base);
  const containsJsx = /<[A-Za-z][^>]*>/.test(text) || /React\.createElement\(/.test(text);
  if (componentMatch && containsJsx) return key === 'card' && /(?:panel|surface)$/.test(base) ? 95 : 120;
  if (!containsJsx) return 0;
  if (!matcher.test(text)) return 0;
  const parts = relative.toLowerCase().split(/[\\/]/);
  const componentFolder = parts.some((part) => ['components', 'component', 'ui', 'shared'].includes(part));
  const pageFile = parts.includes('pages') || /page/i.test(path.basename(relative));
  return componentFolder ? 70 : pageFile ? 45 : 30;
}

function locateExportName(text: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : filePath.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) found = node.name.text;
    else if (ts.isVariableStatement(node)) {
      const name = node.declarationList.declarations.find((decl) => ts.isIdentifier(decl.name) && /component|button|card|input|field|header/i.test(decl.name.text));
      if (name && ts.isIdentifier(name.name)) found = name.name.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found || path.basename(filePath, path.extname(filePath));
}

function isExportedUiComponent(text: string, filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
  const hasJsx = (node: ts.Node): boolean => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found) found = hasJsx(child); });
    return found;
  };
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));
    if (!exported) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && hasJsx(statement)) return true;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => declaration.initializer && hasJsx(declaration.initializer))) return true;
  }
  return sourceFile.statements.some((statement) => ts.isExportAssignment(statement) && statement.expression.kind === ts.SyntaxKind.Identifier);
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
  for (const component of evidence.components) {
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

function isUiRequest(prompt: string, selectedPaths: readonly string[]): boolean {
  return selectedPaths.some((file) => /\.(?:tsx|jsx|css|scss|sass|less)$/i.test(file))
    || /\b(ui|user interface|screen|page|component|button|card|form|field|layout|styling|style|css|tailwind|dashboard|frontend|visual|navigation|navbar|sidebar|modal|dialog|design|website|webpage)\b/i.test(prompt);
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
    const projects = (await this.ports.projects()).filter((project) => TARGET_NAMES.has(project.name.toLowerCase()));
    const picks = await this.loadPicks();
    const evidence = await Promise.all(projects.map((project) => this.readProject(project)));
    for (const item of evidence) {
      for (const component of item.components) {
        component.projects = evidence.filter((other) => other.components.some((candidate) => candidate.key === component.key)).length;
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
        summaries.push(designProfileSummarySchema.parse({ projectId: projects.find((project) => project.path === item.root)?.id ?? item.name, projectName: item.name, projectPath: item.root, status: 'user-owned', componentCount: item.components.length, score: Math.round(item.components.reduce((sum, component) => sum + component.score, 0)), updatedAt: null, agentsPasteLine: `See .kai/spec/design/profile.md for the approved design profile of ${item.name}.` }));
        continue;
      }
      const oldStatus = displayStatus(existing);
      const draft = renderProfile(item, 'Draft');
      const approvedCandidate = renderProfile(item, 'Approved');
      const comparable = (value: string) => value.replace(/^Status:\s*(?:Approved|Draft)\s*$/im, 'Status: Draft').replace(/^Score:.*$/gm, 'Score: (computed)');
      const status = oldStatus === 'approved' && existing && comparable(existing) === comparable(draft) ? 'Approved' : 'Draft';
      const content = status === 'Approved' ? approvedCandidate : draft;
      if (existing !== content) await this.spec.write(item.root, PROFILE_PATH, content);
      const current = await this.spec.read(item.root, PROFILE_PATH);
      const stats = await fs.stat(path.join(item.root, '.kai', 'spec', PROFILE_PATH));
      const designPath = await resolveInside(item.root, 'DESIGN.md');
      const agentsPath = await resolveInside(item.root, 'AGENTS.md');
      const agents = await fs.readFile(agentsPath, 'utf8').catch(() => null);
      const pasteLine = agents?.startsWith('<!-- kai:agents -->') ? null : `See .kai/spec/design/profile.md for the approved design profile of ${item.name}.`;
      summaries.push(designProfileSummarySchema.parse({
        projectId: projects.find((project) => project.path === item.root)?.id ?? item.name,
        projectName: item.name,
        projectPath: item.root,
        status: displayStatus(current),
        componentCount: item.components.length,
        score: Math.round(item.components.reduce((sum, component) => sum + component.score, 0)),
        updatedAt: stats.mtime.toISOString(),
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
    let approved = await this.spec.read(projectRoot, PROFILE_PATH);
    if (!approved?.startsWith(DESIGN_PROFILE_MARKER)) return '';
    if (!this.evidenceByPath.has(path.resolve(projectRoot))) {
      await this.refresh();
      approved = await this.spec.read(projectRoot, PROFILE_PATH);
    }
    if (!approved?.startsWith(DESIGN_PROFILE_MARKER) || displayStatus(approved) !== 'approved') return '';
    const evidence = this.evidenceByPath.get(path.resolve(projectRoot));
    if (!evidence) return '';
    const component = (key: string) => evidence.components.find((item) => item.key === key);
    const promptKey = /\b(button|card|form field|input|field|page header|header)\b/i.exec(prompt)?.[1]?.toLowerCase();
    const selected = selectedPaths.join(' ').toLowerCase();
    const relevantKeys = promptKey
      ? [promptKey.includes('button') ? 'button' : promptKey.includes('card') ? 'card' : promptKey.includes('header') ? 'page-header' : 'field']
      : selected.includes('button') ? ['button'] : selected.includes('card') ? ['card'] : selected.match(/field|input/) ? ['field'] : selected.match(/header/) ? ['page-header'] : ['button', 'card', 'field', 'page-header'];
    const blocks = relevantKeys.map((key) => component(key)).filter((item): item is ComponentEvidence => Boolean(item));
    if (blocks.length === 0) return '';
    const lines = [
      '## Approved project design profile',
      `Project: ${evidence.name}. Use this code as the starting point for UI work.`,
      ...blocks.flatMap((item) => [`### ${item.label} from ${item.source}`, '```tsx', item.code, '```']),
      ...(evidence.variables.length ? [`CSS variables: ${evidence.variables.slice(0, 24).map((item) => `${item.key}: ${item.value}`).join('; ')}`] : []),
      ...(evidence.sharedClasses.length ? [`Shared classes: ${evidence.sharedClasses.slice(0, 20).map((item) => `.${item.name}`).join(', ')}`] : []),
    ];
    let result = lines.join('\n');
    if (result.length > PROFILE_DELIVERY_BUDGET) {
      result = `${result.slice(0, PROFILE_DELIVERY_BUDGET - 30)}\n[Profile excerpt clipped to 6,000 characters]`;
    }
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
    for (const definition of COMPONENTS) {
      const candidate = files
        .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file.relative).toLowerCase()) && isExportedUiComponent(file.text, file.relative))
        .map((file) => ({ file, score: componentCandidateScore(file.relative, file.text, definition.key, definition.matches) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.file.relative.localeCompare(b.file.relative))[0]?.file;
      if (!candidate) continue;
      const exportName = locateExportName(candidate.text, candidate.relative);
      const uses = files.filter((file) => file.relative !== candidate.relative && SOURCE_EXTENSIONS.has(path.extname(file.relative).toLowerCase()))
        .reduce((sum, file) => sum + (file.text.match(new RegExp(`\\b${escapeRegExp(exportName)}\\b`, 'g'))?.length ?? 0), 0);
      const ageDays = Math.max(0, (now - candidate.mtime) / 86_400_000);
      const recency = Math.max(0, Math.round(100 - ageDays / 365 * 100));
      const score = uses * 3 + recency / 10;
      components.push({ key: definition.key, label: definition.label, exportName, source: candidate.relative, code: candidate.text.trim(), uses, projects: 0, recency, picks: 0, score });
    }
    const guide = await this.spec.read(project.path, 'style-guide.md');
    const tokens = await this.spec.read(project.path, 'design/tokens.json');
    const studioReferences = [guide ? '.kai/spec/style-guide.md' : '', tokens ? '.kai/spec/design/tokens.json' : ''].filter(Boolean);
    return { name: project.name, root: project.path, files, tailwind, variables, sharedClasses: shared, components, studioReferences, differences: studioDifferences(guide, tokens, variables) };
  }
}
