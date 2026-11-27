import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignProfileService, DESIGN_PROFILE_MARKER, PROFILE_DELIVERY_BUDGET } from '../apps/desktop/src/main/design-profile';
import { SpecStore } from '../apps/desktop/src/main/spec-store';

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function createProject(root: string, name: string): Promise<void> {
  await write(root, 'tailwind.config.js', 'module.exports = { theme: { extend: { colors: { ink: "#123456" } } } };');
  await write(root, 'src/styles.css', ':root { --radius-card: 14px; --color-ink: #123456; }\n.button-primary { border-radius: var(--radius-card); }\n.button-primary:hover { box-shadow: 0 2px 4px #0002; }');
  await write(root, 'src/components/Button.tsx', 'export function Button() { return <button className="button-primary">Save</button>; }');
  await write(root, 'src/components/Card.tsx', 'export function Card() { return <section className="card">Body</section>; }');
  await write(root, 'src/components/Input.tsx', 'export function Input() { return <input aria-label="Name" />; }');
  await write(root, 'src/components/PageHeader.tsx', 'export function PageHeader() { return <header><h1>Page</h1></header>; }');
  await write(root, 'src/App.tsx', 'import { Button } from "./components/Button"; import { Card } from "./components/Card"; import { Input } from "./components/Input"; import { PageHeader } from "./components/PageHeader"; export function App() { return <><PageHeader /><Card /><Input /><Button /></>; }');
  await write(root, 'src/AnotherPage.tsx', 'import { Button } from "./components/Button"; import { Card } from "./components/Card"; import { Input } from "./components/Input"; import { PageHeader } from "./components/PageHeader"; export function AnotherPage() { return <><PageHeader /><Card /><Input /><Button /></>; }');
  await write(root, 'src/pages/AccountPage.tsx', 'export function AccountPage() { return <main><header><h1>Account</h1></header><form><input /><button>Save</button></form></main>; }');
  await write(root, 'package.json', JSON.stringify({ name }));
}

describe('project design profiles', () => {
  it('writes a code-generated draft, protects user files, and serves only after approval', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-design-profile-'));
    try {
      const projectRoot = path.join(root, 'alpha');
      const books = path.join(root, 'beta');
      const empty = path.join(root, 'gamma');
      await createProject(projectRoot, 'alpha');
      await createProject(books, 'beta');
      await write(empty, 'src/pages/Overview.tsx', 'export function Overview() { return <main><header><h1>Overview</h1></header><button>Go</button></main>; }');
      await write(projectRoot, '.kai/spec/design/style-guide.md', 'Cards should use square corners.');
      await write(projectRoot, '.kai/spec/design/tokens.json', JSON.stringify({ colorInk: '#ff0000' }));
      await write(projectRoot, 'AGENTS.md', '# My instructions\nKeep this file as written.');
      await write(projectRoot, 'DESIGN.md', '# Project design\nKeep the existing deep blue and rounded corners.');
      await write(books, '.kai/spec/design/profile.md', '# This profile belongs to the developer.');
      const originalAgents = await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8');
      const originalBooksProfile = await fs.readFile(path.join(books, '.kai/spec/design/profile.md'), 'utf8');
      const service = new DesignProfileService(path.join(root, 'picks.json'), new SpecStore(), {
        projects: async () => [
          { id: 'alpha', name: 'alpha', path: projectRoot },
          { id: 'beta', name: 'beta', path: books },
          { id: 'gamma', name: 'gamma', path: empty },
        ],
        now: () => Date.parse('2026-11-26T12:00:00.000Z'),
      });

      const profiles = await service.state(true);
      const draft = profiles.find((profile) => profile.projectPath === projectRoot)!;
      expect(draft.status).toBe('missing');
      expect(profiles.find((profile) => profile.projectPath === books)?.status).toBe('user-owned');
      expect(profiles.find((profile) => profile.projectPath === empty)?.componentCount).toBe(0);
      await expect(fs.access(path.join(projectRoot, '.kai/spec/design/profile.md'))).rejects.toThrow();
      await service.generateDraft(projectRoot);
      await service.generateDraft(empty);
      expect(await fs.readFile(path.join(empty, '.kai/spec/design/profile.md'), 'utf8')).toContain('Component: none found');
      const markdown = await fs.readFile(path.join(projectRoot, '.kai/spec/design/profile.md'), 'utf8');
      expect(markdown.startsWith(DESIGN_PROFILE_MARKER)).toBe(true);
      expect(markdown).toContain('Status: Draft');
      expect(markdown).toContain('src/components/Button.tsx');
      expect(markdown).toContain('function Button()');
      expect(markdown).toContain('--radius-card: 14px');
      expect(markdown).toContain('code is #123456; tokens.json is #ff0000');
      expect(markdown).toContain('projects 2');
      expect(await service.briefing(projectRoot, 'Build a React page')).toContain('Existing DESIGN.md');
      expect(await service.briefing(projectRoot, 'database design')).toBe('');

      const approved = await service.approve(projectRoot);
      expect(approved.status).toBe('approved');
      const uiProfile = await service.briefing(projectRoot, 'Build the Button component');
      expect(uiProfile).toContain('Existing DESIGN.md (highest priority)');
      expect(uiProfile.indexOf('Project design')).toBeLessThan(uiProfile.indexOf('Approved generated profile'));
      expect(uiProfile).toContain('function Button()');
      expect(uiProfile.length).toBeLessThanOrEqual(PROFILE_DELIVERY_BUDGET);
      expect((uiProfile.match(/```/g)?.length ?? 0) % 2).toBe(0);
      expect(await service.briefing(projectRoot, 'database design')).toBe('');
      expect(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).toBe(originalAgents);
      expect(approved.agentsPasteLine).toContain('.kai/spec/design/profile.md');
      expect(await fs.readFile(path.join(books, '.kai/spec/design/profile.md'), 'utf8')).toBe(originalBooksProfile);
      expect(await fs.readFile(path.join(projectRoot, 'DESIGN.md'), 'utf8')).toContain('Keep the existing deep blue');

      await service.recordPick(projectRoot, 'button', projectRoot);
      const picked = (await service.state(true)).find((profile) => profile.projectPath === projectRoot)!;
      expect(picked.status).toBe('approved');
      expect(picked.components.find((component) => component.key === 'button')?.score).toBeGreaterThan(
        profiles.find((profile) => profile.projectPath === projectRoot)!.components.find((component) => component.key === 'button')!.score,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
