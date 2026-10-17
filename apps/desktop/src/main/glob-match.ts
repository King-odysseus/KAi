/** A small glob for user-written tool and path rules: `*` stays inside a segment, `**` crosses them. */
export function globMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/').trim();
  const normalizedValue = value.replace(/\\/g, '/').trim();
  if (!normalizedPattern) return false;
  if (normalizedPattern === '*') return true;

  let source = '';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*') {
      if (normalizedPattern[index + 1] === '*') {
        source += '.*';
        index += 1;
        // `src/**/x` should also match `src/x`.
        if (normalizedPattern[index + 1] === '/') index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i').test(normalizedValue);
  } catch {
    return false;
  }
}

/** Command prefixes match at a token boundary: `git push` matches `git push --force`, not `git pushd`. */
export function commandMatchesPrefix(command: string, prefix: string): boolean {
  const normalizedCommand = command.trim().replace(/\s+/g, ' ');
  const normalizedPrefix = prefix.trim().replace(/\s+/g, ' ');
  if (!normalizedPrefix) return false;
  if (normalizedCommand === normalizedPrefix) return true;
  return normalizedCommand.startsWith(`${normalizedPrefix} `);
}
