/** Images produced by a provider, separate from images attached by the user. */
export interface GeneratedImage {
  name: string;
  dataUrl: string;
}

const IMAGE_TOOL_MODELS = new Set([
  'chat-latest', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro',
  'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.6-cyber', 'gpt-5.6-luna', 'gpt-5.6-sol',
  'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra',
]);

export function supportsImageGenerationTool(provider: string, model: string): boolean {
  return provider === 'openai' && IMAGE_TOOL_MODELS.has(model.trim().toLowerCase());
}

/** The Responses image tool's result is a base64 PNG when output_format is png. */
export function generatedImageFromOutputItem(item: Record<string, unknown> | undefined): { id: string; dataUrl: string } | null {
  if (item?.type !== 'image_generation_call' || typeof item.result !== 'string') return null;
  const id = typeof item.id === 'string' ? item.id : '';
  const base64 = item.result;
  if (!id || base64.length === 0 || base64.length > 29_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { id, dataUrl: `data:image/png;base64,${base64}` };
}
