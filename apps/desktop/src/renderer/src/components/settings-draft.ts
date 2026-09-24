/** Keep locally edited fields when background settings refreshes arrive. */
export function reconcileSettingsDraft<T>(draft: T, previous: T, incoming: T): T {
  if (JSON.stringify(draft) === JSON.stringify(previous)) return incoming;
  if (isRecord(draft) && isRecord(previous) && isRecord(incoming)) {
    return Object.fromEntries([...new Set([...Object.keys(incoming), ...Object.keys(draft)])].map((key) => [
      key, reconcileSettingsDraft(draft[key], previous[key], incoming[key]),
    ])) as T;
  }
  return draft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
