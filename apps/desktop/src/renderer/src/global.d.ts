import type { KaiDesktopBridge } from '@kai/contracts';

declare global {
  interface Window {
    kaiDesktop: KaiDesktopBridge;
  }
}

export {};
