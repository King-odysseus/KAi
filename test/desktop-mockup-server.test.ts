import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCKUP_CSP, publishInlineMockup, publishProjectMockup, serveMockup } from '../apps/desktop/src/main/mockup-server';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('mockup server', () => {
  it('serves an inline mockup under its own policy and nothing else beside it', async () => {
    const { url } = publishInlineMockup('<h1>Hello</h1><script>1</script>');
    const page = await serveMockup(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<h1>Hello</h1>');
    expect(page.headers.get('Content-Security-Policy')).toBe(MOCKUP_CSP);
    expect(MOCKUP_CSP).toContain("connect-src 'none'");
    expect((await serveMockup(url.replace('index.html', 'other.html'))).status).toBe(404);
    expect((await serveMockup('kai-mockup://not-a-real-token/index.html')).status).toBe(404);
  });

  it('serves a project page with its own styles and scripts, but not other files or anything outside', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-mockup-'));
    directories.push(root);
    await fs.mkdir(path.join(root, 'mock'));
    await fs.writeFile(path.join(root, 'mock', 'home.html'), '<link rel="stylesheet" href="app.css">');
    await fs.writeFile(path.join(root, 'mock', 'app.css'), 'body{color:red}');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(root, 'mock', 'notes.txt'), 'no');
    const { url } = await publishProjectMockup(root, 'mock/home.html');
    expect(url).toMatch(/\/mock\/home\.html$/);
    expect((await serveMockup(url)).status).toBe(200);
    const css = await serveMockup(url.replace('home.html', 'app.css'));
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect((await serveMockup(url.replace('mock/home.html', '.env'))).status).toBe(404);
    expect((await serveMockup(url.replace('home.html', 'notes.txt'))).status).toBe(404);
    expect((await serveMockup(url.replace('mock/home.html', '..%2F..%2Fsecret.css'))).status).toBe(404);
    await expect(publishProjectMockup(root, 'mock/app.css')).rejects.toThrow(/HTML/);
    await expect(publishProjectMockup(root, '../x.html')).rejects.toThrow();
  });
});
