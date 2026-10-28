import { useEffect, useState, type ReactNode } from 'react';
import { unwrap } from '../types';

/**
 * A running mockup: an agent's HTML, CSS and script, shown in a frame. The frame is sandboxed with script allowed and
 * nothing else, so it has no access to the app, and it is served from its own scheme with a policy that blocks
 * network calls and forms (see main/mockup-server.ts).
 */
export function MockupFrame({ html, projectId, path, title, height = 420 }: { html?: string; projectId?: string; path?: string; title: string; height?: number | string }): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.kaiDesktop;
    if (!api?.publishInlineMockup) return;
    let cancelled = false;
    // A reply streams in, so wait for it to settle rather than publishing every half-written tag.
    const timer = window.setTimeout(() => {
      const request = path && projectId ? api.publishProjectMockup(projectId, path) : html ? api.publishInlineMockup(html) : null;
      if (!request) return;
      setError(null);
      void request.then(unwrap).then((published) => { if (!cancelled) setUrl(published.url); })
        .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'The mockup could not be previewed.'); });
    }, html ? 500 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [html, projectId, path]);

  if (error) return <div className="mockup-frame-status" role="alert">{error}</div>;
  if (!url) return <div className="mockup-frame-status" role="status">Preparing the preview…</div>;
  return (
    <iframe
      className="mockup-frame"
      title={title}
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height }}
    />
  );
}

/** Whether a reply's code block is a whole web page or a fragment worth drawing. */
export function isMockupHtml(language: string, text: string): boolean {
  if (!['html', 'htm'].includes(language.toLowerCase())) return false;
  return /<(?:!doctype|html|body|div|section|main|header|nav|form|button|svg|style|h[1-6]|p|ul|table|canvas)\b/i.test(text);
}
