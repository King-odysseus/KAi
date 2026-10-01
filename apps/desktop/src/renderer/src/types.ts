import type { IpcResponse } from '@kai/contracts';

export type ViewId = 'workspace' | 'studio' | 'graph' | 'projects' | 'brain' | 'rules' | 'proxy' | 'workflows' | 'history' | 'usage' | 'operations' | 'code' | 'tasks' | 'git' | 'settings';

export function unwrap<T>(response: IpcResponse<T>): T {
  if (!response.ok) throw new Error(response.error.message);
  return response.data;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return value;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
