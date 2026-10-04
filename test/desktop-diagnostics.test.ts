import { describe, expect, it } from 'vitest';
import { createDefaultSettings, type LogEntry, type ServiceState } from '../packages/contracts/src';
import { buildDiagnosticsReport, redactForReport } from '../apps/desktop/src/main/diagnostics-report';

const SECRETS = {
  openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  loopback: 'kQ3xT9mZ7bVnC2LpR8sYwA5dHfJgE1uNoI4tX6yBzMc',
  keyValue: 'api_key=super-secret-value-123',
  password: 'password: "hunter2hunter2"',
};

function logs(): LogEntry[] {
  return [
    { timestamp: '2026-09-24T10:00:00.000Z', severity: 'error', category: 'proxy_error', message: `Upstream rejected ${SECRETS.openai}`, detail: `${SECRETS.bearer} ${SECRETS.keyValue}` },
    { timestamp: '2026-09-24T10:01:00.000Z', severity: 'warn', category: 'service_error', message: `token ${SECRETS.loopback} leaked`, detail: SECRETS.password },
    { timestamp: '2026-09-24T10:02:00.000Z', severity: 'info', category: 'internal', message: 'routine info that should not appear as a problem' },
  ];
}

const services: ServiceState[] = [
  { kind: 'cognitive1', status: 'ready', detail: 'Cognitive1 is ready.', endpoint: 'http://127.0.0.1:9876', version: '1.0.0', updatedAt: '2026-09-24T10:00:00.000Z' },
  { kind: 'universalProxy', status: 'failed', detail: 'Process exited with code 1.', endpoint: 'http://127.0.0.1:8083', version: '1.9.0', restarts: 3, restartsExhausted: true, updatedAt: '2026-09-24T10:00:00.000Z' },
];

function report(overrides: Partial<Parameters<typeof buildDiagnosticsReport>[0]> = {}): string {
  const settings = createDefaultSettings();
  settings.directApi.baseUrl = 'https://user:pa55word@api.example.test/v1?key=abc123';
  return buildDiagnosticsReport({
    generatedAt: new Date('2026-09-24T12:00:00.000Z'),
    appName: 'KAI',
    version: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    versions: { electron: '36.9.5', node: '22.1.0', chrome: undefined },
    settings,
    services,
    agents: [{ id: 'codex', available: true, version: 'codex-cli 0.153.4' }, { id: 'gemini', available: false, detail: 'Not installed.' }],
    logs: logs(),
    pendingCalls: [],
    ...overrides,
  });
}

describe('diagnostics report', () => {
  it('includes the facts a bug report needs', () => {
    const text = report();
    expect(text).toContain('KAI 0.1.0 on win32 x64');
    expect(text).toContain('electron 36.9.5');
    expect(text).not.toContain('chrome');
    expect(text).toContain('- cognitive1: ready (v1.0.0)');
    expect(text).toContain('universalProxy: failed (v1.9.0) — Process exited with code 1. [3 automatic restarts, gave up]');
    expect(text).toContain('- codex: ready codex-cli 0.153.4');
    expect(text).toContain('- gemini: unavailable — Not installed.');
    expect(text).toContain('Direct API: on');
    expect(text).toContain('[error]');
    expect(text).toContain('[warn]');
    expect(text).not.toContain('routine info');
  });

  it('never contains a credential, token or password, wherever it appears', () => {
    const text = report();
    for (const [name, secret] of Object.entries(SECRETS)) {
      const core = secret.replace(/^(Bearer |api_key=|password: ")/, '').replace(/"$/, '');
      expect(text, name).not.toContain(core);
    }
    // Credentials embedded in a settings URL are reduced to the host.
    expect(text).not.toContain('pa55word');
    expect(text).not.toContain('abc123');
    expect(text).toContain('host api.example.test');
    expect(text).toContain('[REDACTED]');
  });

  it('keeps ordinary hashes and versions readable', () => {
    const text = redactForReport('commit 8a7a8f2c1b9e4d3f5a6b7c8d9e0f1a2b3c4d5e6f built with node 22.1.0');
    expect(text).toContain('8a7a8f2c1b9e4d3f5a6b7c8d9e0f1a2b3c4d5e6f');
    expect(text).toContain('22.1.0');
  });

  it('hides the user name inside home-folder paths', () => {
    const text = redactForReport('Cannot read C:\\Users\\Mega-Mind\\Documents\\app.json and /home/nate/.config/x and /Users/jo/file');
    expect(text).not.toContain('Mega-Mind');
    expect(text).not.toContain('nate');
    expect(text).not.toContain('/Users/jo');
    expect(text).toContain('<user>');
  });

  it('says so when nothing has gone wrong', () => {
    expect(report({ logs: [] })).toContain('- none recorded');
  });

  it('names the calls that have not answered, which no log line can', () => {
    // Nothing is logged while a call is merely outstanding, so this section is the only place a hung handler is
    // visible at all — the reason an hour was once spent reading a healthy log for a call that never came back.
    const text = report({ pendingCalls: [{ channel: 'auto:start', count: 1, seconds: 3_592 }] });
    expect(text).toContain('## Calls with no answer yet');
    expect(text).toContain('- auto:start: 1 outstanding, waiting 3592s');
  });

  it('says so when every call has answered', () => {
    expect(report()).toContain('## Calls with no answer yet\n- none');
  });
});
