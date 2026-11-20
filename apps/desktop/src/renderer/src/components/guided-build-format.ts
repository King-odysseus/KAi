import { jsonrepair } from 'jsonrepair';

export type GuidedBuildObject = Record<string, unknown>;

/** Read a model's plan object even when it adds prose, a markdown fence, or minor JSON mistakes. */
export function parseGuidedBuildObject(text: string): GuidedBuildObject | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const candidate = firstObject(text, start);
  if (!candidate) return null;
  for (const parse of [
    (value: string) => JSON.parse(value) as GuidedBuildObject,
    (value: string) => JSON.parse(jsonrepair(value)) as GuidedBuildObject,
  ]) {
    try {
      const parsed = parse(candidate);
      if (typeof parsed.title === 'string' && Array.isArray(parsed.steps)) return parsed;
      if (typeof parsed.summary === 'string' && ['ready', 'changes-needed', 'unverified'].includes(String(parsed.status))) return parsed;
    } catch { /* Try the repairing parser next. */ }
  }
  // Some local models produce incomplete JSON. The chat should still not expose the raw plan syntax.
  if (/"title"\s*:/.test(candidate) && /"steps"\s*:\s*\[/.test(candidate)) return { title: '', steps: [] };
  return null;
}

/** Keep any short natural-language introduction while removing the plan/review payload from chat. */
export function visibleGuidedBuildReply(text: string): string {
  if (!parseGuidedBuildObject(text)) return text;
  const start = text.indexOf('{');
  return (start < 0 ? text : text.slice(0, start)).trim();
}

/** Models sometimes return a list of files or instruction strings where the plan expects plain text. */
export function guidedBuildText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, unknown>;
    const file = typeof record.file === 'string' ? record.file : '';
    const place = typeof record.place === 'string' ? record.place : '';
    if (file || place) return [file, place].filter(Boolean).join(' — ');
    return typeof record.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
}

function firstObject(text: string, start: number): string | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}
