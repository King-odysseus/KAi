import type { AppSettings, ServiceState, SetupStatus } from '@kai/contracts';

interface SetupStatusPorts {
  settings(): Promise<AppSettings>;
  projects(): Promise<Array<{ id: string }>>;
  services(): Promise<ServiceState[]>;
  agentCapabilities(): Promise<Array<{ available: boolean; displayName: string; unavailableReason?: string }>>;
  directApiAvailable(): Promise<boolean>;
  directApiDetail(): Promise<string>;
}

/** Build first-run checks without making a network or provider call. */
export async function buildSetupStatus(ports: SetupStatusPorts): Promise<SetupStatus> {
  const [settings, projects, services, capabilities, apiAvailable, apiDetail] = await Promise.all([
    ports.settings(),
    ports.projects(),
    ports.services(),
    ports.agentCapabilities(),
    ports.directApiAvailable(),
    ports.directApiDetail(),
  ]);
  const activeProject = settings.activeProjectId
    ? projects.some((project) => project.id === settings.activeProjectId)
    : false;
  const availableCli = capabilities.filter((capability) => capability.available);
  const cliReady = availableCli.length > 0;
  const cognitive1 = services.find((service) => service.kind === 'cognitive1');
  const proxy = services.find((service) => service.kind === 'universalProxy');
  const checks: SetupStatus['checks'] = [
    {
      id: 'project',
      label: 'Project',
      status: activeProject ? 'ready' : 'blocked',
      detail: activeProject ? 'A project is open and ready to edit.' : 'Open a local project to begin.',
      action: activeProject ? undefined : 'open_project',
    },
    {
      id: 'cli',
      label: 'CLI agent',
      status: cliReady ? 'ready' : apiAvailable ? 'optional' : 'blocked',
      detail: cliReady
        ? `${availableCli.length} signed-in CLI agent${availableCli.length === 1 ? '' : 's'} available.`
        : 'Install and sign in to a CLI agent, or configure a direct API provider.',
      action: cliReady ? undefined : 'open_settings',
    },
    {
      id: 'provider',
      label: 'Direct API',
      status: apiAvailable ? 'ready' : cliReady ? 'optional' : 'blocked',
      detail: apiAvailable ? 'The selected API provider is ready.' : apiDetail,
      action: apiAvailable ? undefined : 'open_settings',
    },
    {
      id: 'cognitive1',
      label: 'Cognitive1 brain',
      status: cognitive1?.status === 'ready' ? 'ready' : 'optional',
      detail: cognitive1?.status === 'ready' ? 'The managed brain service is ready.' : cognitive1?.detail ?? 'Start Cognitive1 when you want shared memory.',
      action: cognitive1?.status === 'ready' ? undefined : 'start_cognitive1',
    },
    {
      id: 'proxy',
      label: 'Universal Proxy',
      status: proxy?.status === 'ready' ? 'ready' : 'optional',
      detail: proxy?.status === 'ready' ? 'The managed proxy is ready.' : proxy?.detail ?? 'Start Universal Proxy when you want CLI agents routed through it.',
      action: proxy?.status === 'ready' ? undefined : 'start_proxy',
    },
  ];
  return {
    complete: settings.setupCompletedAt !== null,
    completedAt: settings.setupCompletedAt,
    checks,
  };
}
