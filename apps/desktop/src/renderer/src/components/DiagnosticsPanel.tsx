import { ClipboardCopy, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ProjectRecord, ServiceState } from '@kai/contracts';
import { statusLabel, unwrap } from '../types';

type CheckTool = 'doctor' | 'compliance_audit' | 'git_status' | 'wiki_status';

const CHECKS: Array<{ tool: CheckTool; label: string; hint: string }> = [
  { tool: 'doctor', label: 'Engine doctor', hint: 'Checks the C1 install: brain integrity, git, sync scripts, config' },
  { tool: 'compliance_audit', label: 'Project compliance', hint: 'Read-only audit of the open project (nothing is fixed automatically)' },
  { tool: 'git_status', label: 'Tracked repositories', hint: 'Git state of the projects C1 tracks' },
  { tool: 'wiki_status', label: 'Brain system status', hint: 'Compliance and dashboard summary' },
];

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  return Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim() : '';
};

export function DiagnosticsPanel({ activeProject }: { activeProject: ProjectRecord | null }): ReactNode {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [results, setResults] = useState<Partial<Record<CheckTool | 'config_get', string>>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [configKey, setConfigKey] = useState('');
  const [configValue, setConfigValue] = useState('');

  const c1Ready = services.some((service) => service.kind === 'cognitive1' && service.status === 'ready');

  const refresh = useCallback(async () => {
    try {
      setServices(unwrap(await window.kaiDesktop.serviceStatus()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Service state could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function tool(name: CheckTool | 'config_get', argumentsValue: Record<string, unknown> = {}): Promise<void> {
    setRunning(name);
    setError(null);
    try {
      const result = unwrap(await window.kaiDesktop.cognitive1Tool({ tool: name, arguments: argumentsValue }));
      setResults((current) => ({ ...current, [name]: textOf(result) || '(no output)' }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${name} failed.`);
    } finally {
      setRunning(null);
    }
  }

  async function copyReport(): Promise<void> {
    try {
      const { text } = unwrap(await window.kaiDesktop.diagnosticsReport(true));
      setReport(text);
      setMessage('Copied. Secrets and your user name are removed, but read it before sharing.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The report could not be built.');
    }
  }

  return (
    <div className="ops-panel">
      {message && <div className="workbench-notice" role="status"><span>{message}</span></div>}
      {error && <div className="workbench-error" role="alert">{error}</div>}

      <section className="settings-section">
        <div className="section-title"><span>Services</span></div>
        <table className="ops-table">
          <thead><tr><th>Service</th><th>State</th><th>Endpoint</th><th>Automatic restarts</th></tr></thead>
          <tbody>
            {services.map((service) => (
              <tr key={service.kind}>
                <td>{service.kind === 'cognitive1' ? 'C1 Brain' : 'Universal Proxy'}</td>
                <td title={service.detail}>{statusLabel(service.status)}</td>
                <td className="truncate" title={service.endpoint ?? ''}>{service.endpoint ?? '—'}</td>
                <td>{service.restartsExhausted ? `Gave up after ${service.restarts}` : service.restarts ? String(service.restarts) : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {services.some((service) => service.restartsExhausted) && <p className="settings-note">A service kept crashing, so KAI stopped restarting it. Restart it from its page once the cause is fixed.</p>}
      </section>

      <section className="settings-section">
        <div className="section-title"><span>Engine checks</span></div>
        {!c1Ready && <p className="settings-note">Start the C1 Brain service to run these checks.</p>}
        {CHECKS.map((check) => (
          <div key={check.tool} className="diagnostic-check">
            <div className="ops-card-head">
              <span><strong>{check.label}</strong> <small>{check.hint}</small></span>
              <button type="button" className="secondary-button" disabled={!c1Ready || running !== null} onClick={() => void tool(check.tool, check.tool === 'compliance_audit' ? { fix: false } : check.tool === 'git_status' && activeProject ? { project: activeProject.name } : {})}><RefreshCw size={13} /><span>{running === check.tool ? 'Running…' : 'Run'}</span></button>
            </div>
            {results[check.tool] && <pre className="verify-output">{results[check.tool]}</pre>}
          </div>
        ))}
      </section>

      <section className="settings-section">
        <div className="section-title"><span>Engine configuration</span></div>
        <div className="ops-actions">
          <button type="button" className="secondary-button" disabled={!c1Ready || running !== null} onClick={() => void tool('config_get')}>Show settings</button>
        </div>
        {results.config_get && <pre className="verify-output">{results.config_get}</pre>}
        <div className="field-grid">
          <label className="field"><span>Setting name</span><input value={configKey} placeholder="logLevel" onChange={(event) => setConfigKey(event.target.value)} /></label>
          <label className="field"><span>New value</span><input value={configValue} onChange={(event) => setConfigValue(event.target.value)} /></label>
        </div>
        <button type="button" className="primary-button align-end" disabled={!c1Ready || !configKey.trim() || !configValue.trim() || running !== null} onClick={() => {
          if (!window.confirm(`Change the C1 setting "${configKey.trim()}" to "${configValue.trim()}"? Cognitive1 validates the value and may need a restart to apply it.`)) return;
          void window.kaiDesktop.cognitive1Tool({ tool: 'config_set', arguments: { key: configKey.trim(), value: configValue.trim() } })
            .then(unwrap)
            .then((result) => { setMessage(textOf(result) || 'Setting saved.'); setConfigKey(''); setConfigValue(''); })
            .catch((caught) => setError(caught instanceof Error ? caught.message : 'The setting could not be changed.'));
        }}>Change setting</button>
      </section>

      <section className="settings-section">
        <div className="section-title"><span>Bug report</span></div>
        <p className="settings-note">Copies versions, service states, a settings summary and recent errors. Keys, tokens and your user name are removed.</p>
        <div className="ops-actions">
          <button type="button" className="primary-button" onClick={() => void copyReport()}><ClipboardCopy size={14} /><span>Copy diagnostics report</span></button>
        </div>
        {report && <pre className="verify-output">{report}</pre>}
      </section>
    </div>
  );
}
