const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_PATTERN = /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?)[^"',\s}]+/gi;
const KNOWN_KEY_PATTERN = /\b(?:sk|gk|xoxb|hf)_[A-Za-z0-9_-]{8,}\b/g;

export function redactText(input: string): string {
  return input
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(KEY_VALUE_PATTERN, '$1[REDACTED]')
    .replace(KNOWN_KEY_PATTERN, '[REDACTED]');
}

export function redactObject(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /key|token|secret|password|authorization/i.test(key) ? '[REDACTED]' : redactObject(item);
    }
    return output;
  }
  return value;
}
