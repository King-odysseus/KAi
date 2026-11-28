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

/**
 * A role that uses the person's own gateway without naming everything about it gets the saved gateway's address and key.
 * Without this, a role naming only the provider would be given the preset's placeholder address whenever the default
 * provider is something else, and would stop counting as the person's own hardware. When the default is itself an
 * OpenAI-compatible service, a role naming no address still means that default, as it always has.
 */
export function withGatewayProfile(
  settings: Pick<AppSettings, 'directApi' | 'gatewayOwnHardware' | 'gatewayAwayUrl' | 'gatewayHomeUrl' | 'gatewayCredentialId'>,
  connection: ApiConnection,
): ApiConnection {
  const { gatewayAwayUrl: away, gatewayHomeUrl: home, gatewayCredentialId: credentialId } = settings;
  if (connection.provider !== 'openai-compatible' || !settings.gatewayOwnHardware || !away) return connection;
  const bare = (url: string): string => url.replace(/\/+$/, '').toLowerCase();
  const meansGateway = connection.baseUrl
    ? [away, home].some((url) => url && bare(url) === bare(connection.baseUrl!))
    : settings.directApi.provider !== 'openai-compatible';
  if (!meansGateway) return connection;
  return {
    ...connection,
    baseUrl: connection.baseUrl ?? away,
    ...(connection.credentialId || !credentialId ? {} : { credentialId }),
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
