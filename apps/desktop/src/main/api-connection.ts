import { directProviderPreset, type ApiConnection, type AppSettings, type ProviderId } from '@kai/contracts';

/**
 * The connection a run uses when a role names its own, filled in from what Settings already knows.
 *
 * A role that names only a provider means "the key I already saved for it". When that is the provider Settings is
 * set to, the address, credential and model saved there apply; for any other provider they come from its preset.
 * The result is always enabled: choosing a connection for a run is the instruction to use the API.
 */
export function resolveApiConnection(
  settingsConnection: AppSettings['directApi'],
  connection: ApiConnection,
): AppSettings['directApi'] {
  const preset = directProviderPreset(connection.provider);
  const same = connection.provider === settingsConnection.provider;
  return {
    enabled: true,
    provider: connection.provider,
    baseUrl: connection.baseUrl ?? (same ? settingsConnection.baseUrl : preset.defaultBaseUrl),
    credentialId: connection.credentialId ?? (same ? settingsConnection.credentialId : preset.credentialId),
    model: connection.model ?? (same ? settingsConnection.model : preset.defaultModel),
  };
}

/** What to do when a local server is not answering, in that server's own words. */
export function localServerHint(provider: ProviderId): string {
  switch (provider) {
    case 'lmstudio':
      return 'Open LM Studio, start its local server (Developer tab), load a model, then refresh.';
    case 'ollama':
      return 'Start Ollama (run `ollama serve`, or open the Ollama app) and pull a model with `ollama pull`, then refresh.';
    case 'llamacpp':
      return 'Start `llama-server` with a model loaded, then refresh.';
    case 'vllm':
      return 'Start the vLLM server (`vllm serve <model>`), then refresh.';
    default:
      return 'Start the local server and load a model, then refresh.';
  }
}
