import { useEffect, useState } from 'react';

/**
 * Installing the console on a home screen. Three cases, and only one of them has a button:
 *
 * - Chromium over a secure context fires `beforeinstallprompt`, which can be shown at a moment of the
 *   page's choosing rather than the browser's. The event is kept, because it can only be used once.
 * - iOS has no prompt event at all. Share → Add to Home Screen is the only route, and it works over
 *   plain http, so the hint is shown whenever the page is not already standalone.
 * - Everything else — most usefully, an Android browser on a plain `http://192.168.x.x` address — cannot
 *   install anything, because service workers and installability both need a secure context. Saying so
 *   is better than hiding the feature and leaving the user to guess.
 */
export type InstallState = 'installed' | 'ready' | 'manual' | 'blocked';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    // An iPad running a desktop user agent reports itself as a Mac, and only the touch points give it away.
    || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function useInstall(): { state: InstallState; install: () => void } {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(isStandalone);

  useEffect(() => {
    const onPrompt = (event: Event): void => {
      // Chrome shows its own mini-infobar unless the default is prevented, which would bury this one.
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = (): void => {
      setPromptEvent(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = (): void => {
    const event = promptEvent;
    setPromptEvent(null);
    void event?.prompt();
  };

  if (standalone) return { state: 'installed', install };
  if (promptEvent) return { state: 'ready', install };
  if (isIos()) return { state: 'manual', install };
  return { state: 'blocked', install };
}
