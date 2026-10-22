/** Only project files that are useful for review may be offered to a peer. */
export function shareableCodePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.toLowerCase().split('/');
  if (!normalized || normalized.startsWith('/') || parts.includes('..')) return false;
  if (parts.some((part) => ['.git', 'node_modules', '.kai', 'dist', 'build', 'release', 'coverage'].includes(part))) return false;
  const name = parts.at(-1) ?? '';
  if (['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'known_hosts'].includes(name)) return false;
  if (name === '.env' || name.startsWith('.env.') || /(?:secret|credential|private.?key|token)/i.test(name)) return false;
  if (/\.(?:pem|key|p12|pfx|sqlite|db|zip|7z|tar|gz|png|jpe?g|gif|webp|ico|pdf|mp4|mov|mp3|wav|woff2?|ttf|otf|exe|dll)$/i.test(name)) return false;
  return true;
}

/** A URL in an invite or Git remote must never be able to smuggle credentials into a peer snapshot. */
export function shareableRepository(repository: string | null): string | null {
  if (!repository) return null;
  return /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(repository) ? repository : null;
}

export function parseTeamInvite(value: string): { roomId: string; password: string } | null {
  const match = /^(?:kai-team:)?([0-9a-f]{32}):([0-9a-f]{32})$/i.exec(value.trim());
  return match ? { roomId: match[1]!, password: match[2]! } : null;
}
