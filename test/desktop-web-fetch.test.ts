import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkedUrl,
  extractTitle,
  fetchWebPage,
  htmlToText,
  isPrivateAddress,
} from '../apps/desktop/src/main/web-tools';

afterEach(() => vi.unstubAllGlobals());

describe('address safety', () => {
  it('classifies private, loopback and reserved IPv4 ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('classifies IPv6 loopback, unique-local and link-local ranges', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses non-http schemes, embedded credentials and private destinations', async () => {
    await expect(checkedUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(checkedUrl('ftp://example.com/file')).rejects.toThrow(/http/);
    await expect(checkedUrl('http://user:pass@example.com/')).rejects.toThrow(/credentials/);
    await expect(checkedUrl('http://127.0.0.1:8080/admin')).rejects.toThrow(/inside this machine/);
    await expect(checkedUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/inside this machine/);
    await expect(checkedUrl('http://[::1]/')).rejects.toThrow(/inside this machine/);
  });
});

describe('page reading', () => {
  it('returns the visible text and the title, and never follows a redirect into a private address', async () => {
    const html = '<html><head><title>Docs &amp; Notes</title><style>body{color:red}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>Some   text.</p></body></html>';
    const fetchMock = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchWebPage('https://93.184.216.34/docs');

    expect(page.title).toBe('Docs & Notes');
    expect(page.text).toContain('Hello');
    expect(page.text).toContain('Some text.');
    expect(page.text).not.toContain('alert(1)');
    expect(page.text).not.toContain('color:red');
  });

  it('rejects a redirect that points at the local machine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } })));
    await expect(fetchWebPage('https://93.184.216.34/start')).rejects.toThrow(/inside this machine/);
  });

  it('rejects a binary content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('pdf', { status: 200, headers: { 'content-type': 'application/pdf' } })));
    await expect(fetchWebPage('https://93.184.216.34/file.pdf')).rejects.toThrow(/not readable text/);
  });

  it('extracts titles and strips hidden content without a dependency', () => {
    expect(extractTitle('<html><head><TITLE> A title </TITLE></head></html>')).toBe('A title');
    const text = htmlToText('<div>One</div><div>Two<br>Three</div><ul><li>Item</li></ul><!-- hidden -->');
    expect(text).toContain('One');
    expect(text).toContain('- Item');
    expect(text).not.toContain('hidden');
  });
});
