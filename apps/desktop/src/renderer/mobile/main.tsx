import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startTheme } from './theme';
import './mobile.css';

// Before the first paint, so a stored theme does not flash the default. Stylesheets are already loaded
// by the time a module runs, which is what lets startTheme read the theme's own --bg-deep.
startTheme();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The offline shell. Registration is refused outright on a plain http address — a secure context is
// required — so this is best-effort and silent: over the LAN the console simply has no shell to fall
// back on, and over Tailscale's HTTPS it does. See docs/desktop/MOBILE_REMOTE.md.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/mobile/sw.js', { scope: '/mobile/' }).catch(() => undefined);
  });
}
