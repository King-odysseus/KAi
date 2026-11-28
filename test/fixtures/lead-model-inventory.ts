export const inventory = {
  apiProviders: [
    { provider: 'lmstudio', credentialId: 'provider.lmstudio', label: 'Local Lab', tier: 'Local' as const, available: true, models: ['local-small', 'local-large'], defaultModel: '', baseUrl: 'http://127.0.0.1:1234/v1' },
    { provider: 'openai', credentialId: 'provider.openai', label: 'Cloud Lab', tier: 'Paid API' as const, available: true, models: ['cloud-fast', 'cloud-strong'], defaultModel: '', baseUrl: 'https://api.example.test/v1' },
  ],
  cliAgents: [{ agent: 'claude' as const, label: 'Claude CLI', tier: 'Subscription' as const, available: true, models: ['sonnet', 'opus'] }],
};
