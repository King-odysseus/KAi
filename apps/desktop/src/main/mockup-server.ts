import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveInside } from './project-files';

/**
 * Live mockups. An agent can design a screen as HTML, CSS and JavaScript, and the person should see it running.
 *
 * The page itself cannot host that: its policy allows no inline script, and loosening it would loosen it for the whole
 * app. So a mockup is served from its own scheme, `kai-mockup:`, which carries its own policy, and is shown in a frame
 * whose `sandbox` gives it no access to the app. Script runs inside the frame and nowhere else; the policy below also
 * shuts every route out of it (`connect-src 'none'`, no forms, no nested frames), so a mockup can draw and respond to
 * clicks but cannot read or send anything.
 */
export const MOCKUP_SCHEME = 'kai-mockup';

/** What a mockup frame may load: its own files and inline code, plus pictures, fonts and styles from the web, which
 * mockups lean on (a CDN stylesheet, a web font). Nothing may be fetched from script. */
export const MOCKUP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
].join('; ');

type Source = { kind: 'inline'; html: string } | { kind: 'project'; root: string };

const MAX_INLINE_BYTES = 2_000_000;
const MAX_SOURCES = 60;
const sources = new Map<string, Source>();

function remember(source: Source): string {
  const token = randomUUID();
  sources.set(token, source);
  // The oldest mockup is dropped first, so a long conversation does not hold every draft it ever showed.
  while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value as string);
  return token;
}

/** A mockup written straight into a reply. */
export function publishInlineMockup(html: string): { url: string } {
  if (Buffer.byteLength(html, 'utf8') > MAX_INLINE_BYTES) throw new Error('This mockup is too large to preview.');
  return { url: `${MOCKUP_SCHEME}://${remember({ kind: 'inline', html })}/index.html` };
}

/**
 * A mockup saved in the project. The whole project folder is served read-only, so the page's own `styles.css`,
 * scripts and pictures load beside it the way they would from a browser.
 */
export async function publishProjectMockup(projectRoot: string, relativePath: string): Promise<{ url: string }> {
  if (!/\.html?$/i.test(relativePath)) throw new Error('Only an HTML file can be previewed.');
  const target = await resolveInside(projectRoot, relativePath);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error('That path is not a file.');
  const root = await fs.realpath(projectRoot);
  const relative = path.relative(root, target).split(path.sep).map(encodeURIComponent).join('/');
  return { url: `${MOCKUP_SCHEME}://${remember({ kind: 'project', root })}/${relative}` };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function reply(status: number, body: string | Buffer, type: string): Response {
  return new Response(body as BodyInit, {
    status,
    headers: { 'Content-Type': type, 'Content-Security-Policy': MOCKUP_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** Answers one `kai-mockup:` request. Anything it cannot place inside the mockup's own source is a 404. */
export async function serveMockup(requestUrl: string): Promise<Response> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return reply(400, 'Bad mockup address.', 'text/plain; charset=utf-8');
  }
  const source = sources.get(url.hostname);
  if (!source) return reply(404, 'This mockup is no longer available. Ask for it again.', 'text/plain; charset=utf-8');
  if (source.kind === 'inline') {
    // Only the document itself exists for a mockup written in a reply.
    return /^\/(?:index\.html)?$/.test(url.pathname) ? reply(200, source.html, TYPES['.html']!) : reply(404, 'Not found.', 'text/plain; charset=utf-8');
  }
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return reply(400, 'Bad mockup address.', 'text/plain; charset=utf-8');
  }
  try {
    const target = await resolveInside(source.root, relative);
    const stats = await fs.stat(target);
    if (!stats.isFile()) return reply(404, 'Not found.', 'text/plain; charset=utf-8');
    const type = TYPES[path.extname(target).toLowerCase()];
    // Only the kinds of file a web page is made of are served; a stray .env or key beside the page is not one.
    if (!type) return reply(404, 'Not found.', 'text/plain; charset=utf-8');
    return reply(200, await fs.readFile(target), type);
  } catch {
    return reply(404, 'Not found.', 'text/plain; charset=utf-8');
  }
}
