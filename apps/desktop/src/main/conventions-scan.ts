import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Finds how a developer usually builds things by reading their projects, and counts it. Nothing here calls a model or
 * records anything the developer did: it reads files that are already on disk, so a convention is a fact with a count
 * ("5 of 8 projects use Tailwind") and not a guess. A pattern becomes a convention only when more than one project
 * shows it, because a single project is an example, not a habit.
 */

export type ConventionArea = 'frontend' | 'styling' | 'backend' | 'database' | 'payments' | 'auth' | 'testing' | 'layout' | 'deploy';

export interface ProjectSnapshot {
  name: string;
  /** Paths relative to the project root, forward slashes, a shallow listing. */
  files: string[];
  /** Dependency names from package.json, when there is one. */
  dependencies: string[];
  /** The text of requirements.txt / pyproject.toml / composer.json and similar, lowercased. */
  manifestText: string;
  /** A little source text (first lines of a handful of files), lowercased, for patterns a manifest cannot show. */
  sourceText: string;
}

interface Detector {
  key: string;
  area: ConventionArea;
  label: string;
  /** Words people use for this, so a goal that mentions one pulls the convention in. */
  topics: string[];
  test: (project: ProjectSnapshot) => boolean;
}

const dep = (project: ProjectSnapshot, ...names: string[]): boolean => names.some((name) => project.dependencies.includes(name));
const manifest = (project: ProjectSnapshot, ...words: string[]): boolean => words.some((word) => project.manifestText.includes(word));
const source = (project: ProjectSnapshot, ...words: string[]): boolean => words.some((word) => project.sourceText.includes(word));
const hasFile = (project: ProjectSnapshot, pattern: RegExp): boolean => project.files.some((file) => pattern.test(file));

const DETECTORS: readonly Detector[] = [
  { key: 'react', area: 'frontend', label: 'React for the interface', topics: ['react', 'ui', 'page', 'component'], test: (p) => dep(p, 'react') },
  { key: 'nextjs', area: 'frontend', label: 'Next.js for pages and routing', topics: ['next', 'page', 'route', 'ssr'], test: (p) => dep(p, 'next') },
  { key: 'vue', area: 'frontend', label: 'Vue for the interface', topics: ['vue', 'ui', 'page'], test: (p) => dep(p, 'vue', 'nuxt') },
  { key: 'tailwind', area: 'styling', label: 'Tailwind CSS for styling', topics: ['style', 'css', 'design', 'ui', 'page', 'tailwind'], test: (p) => dep(p, 'tailwindcss') || hasFile(p, /(^|\/)tailwind\.config\./) },
  { key: 'flowbite', area: 'styling', label: 'Flowbite components', topics: ['component', 'ui', 'design'], test: (p) => dep(p, 'flowbite', 'flowbite-react') },
  { key: 'lucide', area: 'styling', label: 'Lucide icons, not emoji', topics: ['icon', 'ui', 'design'], test: (p) => dep(p, 'lucide-react', 'lucide', 'lucide-vue-next') },
  { key: 'typescript', area: 'frontend', label: 'TypeScript', topics: ['typescript', 'types'], test: (p) => hasFile(p, /(^|\/)tsconfig\.json$/) },
  { key: 'express', area: 'backend', label: 'Express for the API', topics: ['api', 'backend', 'server', 'endpoint'], test: (p) => dep(p, 'express') },
  { key: 'django', area: 'backend', label: 'Django for the backend', topics: ['api', 'backend', 'server', 'endpoint', 'django'], test: (p) => manifest(p, 'django') || hasFile(p, /(^|\/)manage\.py$/) },
  { key: 'fastapi', area: 'backend', label: 'FastAPI for the API', topics: ['api', 'backend', 'endpoint'], test: (p) => manifest(p, 'fastapi') },
  { key: 'laravel', area: 'backend', label: 'Laravel for the backend', topics: ['api', 'backend', 'server'], test: (p) => manifest(p, 'laravel/framework') || hasFile(p, /(^|\/)artisan$/) },
  { key: 'aspnet', area: 'backend', label: 'ASP.NET for the backend', topics: ['api', 'backend', 'server'], test: (p) => hasFile(p, /\.csproj$/) },
  { key: 'postgres', area: 'database', label: 'PostgreSQL', topics: ['database', 'db', 'data', 'schema', 'migration'], test: (p) => dep(p, 'pg', 'postgres') || manifest(p, 'psycopg', 'postgres') || source(p, 'postgresql') },
  { key: 'sqlite', area: 'database', label: 'SQLite', topics: ['database', 'db', 'data', 'local'], test: (p) => dep(p, 'better-sqlite3', 'sqlite3') || manifest(p, 'sqlite') || hasFile(p, /\.sqlite3?$/) },
  { key: 'prisma', area: 'database', label: 'Prisma for data access', topics: ['database', 'db', 'schema', 'migration'], test: (p) => dep(p, 'prisma', '@prisma/client') },
  { key: 'mpesa', area: 'payments', label: 'M-Pesa (STK push) for payments', topics: ['payment', 'pay', 'checkout', 'billing', 'mpesa', 'mobile money'], test: (p) => source(p, 'mpesa', 'stk push', 'stkpush', 'daraja') || hasFile(p, /mpesa/i) },
  { key: 'stripe', area: 'payments', label: 'Stripe for payments', topics: ['payment', 'pay', 'checkout', 'billing', 'subscription', 'stripe'], test: (p) => dep(p, 'stripe', '@stripe/stripe-js') || manifest(p, 'stripe') },
  { key: 'jwt', area: 'auth', label: 'JWT tokens for sign-in', topics: ['auth', 'login', 'sign in', 'sign-in', 'session', 'user'], test: (p) => dep(p, 'jsonwebtoken', 'jose') || manifest(p, 'pyjwt', 'djangorestframework-simplejwt') },
  { key: 'oauth', area: 'auth', label: 'OAuth or an auth library for sign-in', topics: ['auth', 'login', 'sign in', 'sign-in', 'google'], test: (p) => dep(p, 'next-auth', '@auth/core', 'passport', '@clerk/nextjs') || manifest(p, 'django-allauth') },
  { key: 'vitest', area: 'testing', label: 'Vitest for tests', topics: ['test', 'testing', 'verify'], test: (p) => dep(p, 'vitest') },
  { key: 'jest', area: 'testing', label: 'Jest for tests', topics: ['test', 'testing', 'verify'], test: (p) => dep(p, 'jest') },
  { key: 'pytest', area: 'testing', label: 'pytest for tests', topics: ['test', 'testing', 'verify'], test: (p) => manifest(p, 'pytest') },
  { key: 'playwright', area: 'testing', label: 'Playwright for browser checks', topics: ['test', 'e2e', 'browser', 'ui'], test: (p) => dep(p, '@playwright/test', 'playwright') },
  { key: 'src-folder', area: 'layout', label: 'Source code under src/', topics: ['structure', 'folder', 'layout', 'new project', 'scaffold'], test: (p) => hasFile(p, /^src\//) },
  { key: 'monorepo', area: 'layout', label: 'A monorepo with apps/ and packages/', topics: ['structure', 'folder', 'layout', 'scaffold', 'monorepo'], test: (p) => hasFile(p, /^apps\//) && hasFile(p, /^packages\//) },
  { key: 'docker', area: 'deploy', label: 'Docker for running and deploying', topics: ['deploy', 'docker', 'hosting', 'setup'], test: (p) => hasFile(p, /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/) },
  { key: 'github-actions', area: 'deploy', label: 'GitHub Actions for builds', topics: ['deploy', 'ci', 'build', 'release'], test: (p) => hasFile(p, /^\.github\/workflows\//) },
];

export interface Convention {
  key: string;
  area: ConventionArea;
  label: string;
  topics: string[];
  count: number;
  total: number;
  /** Project names that show it, most recent first as given. */
  projects: string[];
}

export interface ConventionProfile {
  generatedAt: string;
  total: number;
  conventions: Convention[];
}

/** Which conventions one project shows. */
export function detect(project: ProjectSnapshot): string[] {
  return DETECTORS.filter((detector) => {
    try { return detector.test(project); } catch { return false; }
  }).map((detector) => detector.key);
}

/**
 * Counts conventions across projects. Only patterns shown by at least two projects, and by at least a third of them
 * once there are more than three, are kept: the rest are one-off choices.
 */
export function buildProfile(projects: readonly ProjectSnapshot[], at: string): ConventionProfile {
  const total = projects.length;
  const found = new Map<string, string[]>();
  for (const project of projects) {
    for (const key of detect(project)) found.set(key, [...(found.get(key) ?? []), project.name]);
  }
  const minimum = total > 3 ? Math.ceil(total / 3) : 2;
  const conventions = DETECTORS.flatMap((detector): Convention[] => {
    const names = found.get(detector.key) ?? [];
    if (names.length < 2 || names.length < minimum) return [];
    return [{ key: detector.key, area: detector.area, label: detector.label, topics: detector.topics, count: names.length, total, projects: names }];
  }).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { generatedAt: at, total, conventions };
}

/**
 * The few lines worth showing an agent for one goal: conventions whose topics the goal mentions, plus the stack ones
 * that apply to nearly any build, capped so the brief stays small. Empty when the profile has nothing relevant.
 */
export function conventionsFor(profile: ConventionProfile, goal: string, limit = 8): string[] {
  const text = goal.toLowerCase();
  const mentions = (convention: Convention): boolean => convention.topics.some((topic) => text.includes(topic));
  const broad = (convention: Convention): boolean => convention.count / convention.total >= 0.5;
  const picked = profile.conventions.filter((convention) => mentions(convention) || (broad(convention) && ['frontend', 'styling', 'backend', 'testing'].includes(convention.area)));
  return picked.slice(0, limit).map((convention) => `${convention.label} (${convention.count} of ${convention.total} of your projects, for example ${convention.projects.slice(0, 3).join(', ')}).`);
}

/** A draft note for C1's review queue. The developer approves or rejects it; nothing is written as settled. */
export function conventionDraft(convention: Convention, at: string): { title: string; tags: string[]; body: string } {
  return {
    title: `Convention: ${convention.label}`,
    tags: ['convention', convention.area, convention.key],
    body: [
      `**Pattern:** ${convention.label}.`,
      `**Evidence:** ${convention.count} of ${convention.total} scanned projects (${convention.projects.join(', ')}), read on ${at.slice(0, 10)}.`,
      '**When to use:** When starting or extending a project in this area, follow it unless the task says otherwise.',
    ].join('\n'),
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', 'vendor', 'release', 'coverage', '.tmp']);
const MANIFESTS = ['requirements.txt', 'pyproject.toml', 'composer.json', 'Gemfile', 'go.mod', 'Cargo.toml'];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.php', '.cs', '.vue', '.md']);
const MAX_FILES = 1_500;
const MAX_DEPTH = 4;
const SOURCE_FILES = 40;
const SOURCE_BYTES = 4_000;

/** Reads a project folder into a snapshot: a shallow file list, its dependencies and a little source. Never writes. */
export async function snapshotProject(root: string, name = path.basename(root)): Promise<ProjectSnapshot> {
  const files: string[] = [];
  const sourceFiles: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        files.push(relative);
        if (SOURCE_EXT.has(path.extname(entry.name)) && sourceFiles.length < SOURCE_FILES) sourceFiles.push(relative);
      }
    }
  }
  await walk(root, 0);

  const dependencies: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies']) {
      const group = parsed[field];
      if (group && typeof group === 'object') dependencies.push(...Object.keys(group));
    }
  } catch { /* no package.json, or one that does not parse: the file list still says plenty */ }

  const read = async (file: string, limit: number): Promise<string> => {
    try {
      const handle = await fs.open(path.join(root, file), 'r');
      try {
        const buffer = Buffer.alloc(limit);
        const { bytesRead } = await handle.read(buffer, 0, limit, 0);
        return buffer.subarray(0, bytesRead).toString('utf8').toLowerCase();
      } finally { await handle.close(); }
    } catch { return ''; }
  };
  const manifestText = (await Promise.all(MANIFESTS.filter((file) => files.includes(file)).map((file) => read(file, 20_000)))).join('\n');
  const sourceText = (await Promise.all(sourceFiles.map((file) => read(file, SOURCE_BYTES)))).join('\n');
  return { name, files, dependencies, manifestText, sourceText };
}

/** Scans several project folders into one profile. A folder that cannot be read is skipped, not fatal. */
export async function scanProjects(roots: readonly string[], at: string = new Date().toISOString()): Promise<ConventionProfile> {
  const snapshots: ProjectSnapshot[] = [];
  for (const root of roots) {
    try {
      const stat = await fs.stat(root);
      if (stat.isDirectory()) snapshots.push(await snapshotProject(root));
    } catch { /* skip */ }
  }
  return buildProfile(snapshots, at);
}
