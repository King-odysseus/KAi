import { useEffect, useState, type ReactNode } from 'react';
import { Check, KeyRound, Loader2, PenTool, PlugZap } from 'lucide-react';
import { OPENPENCIL_ENDPOINT, type OpenPencilStatus } from '@kai/contracts';
import { unwrap } from '../types';

/**
 * The open-pencil connection. The Project Studio reads tokens, components and pages from the editor over MCP, and
 * KAI agents draw screens in it, so this is where the address and token live. The token goes straight into the OS
 * vault and is never shown again: the card only ever learns whether one is stored.
 */
export function OpenPencilCard(): ReactNode {
  const [status, setStatus] = useState<OpenPencilStatus | null>(null);
  const [endpoint, setEndpoint] = useState(OPENPENCIL_ENDPOINT);
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.kaiDesktop.openPencilStatus().then(unwrap).then((next) => {
      if (cancelled) return;
      setStatus(next);
      setEndpoint(next.endpoint);
      setEnabled(next.enabled);
    }).catch((caught) => {
      if (!cancelled) setFeedback({ ok: false, message: caught instanceof Error ? caught.message : 'Could not read the open-pencil settings.' });
    });
    return () => { cancelled = true; };
  }, []);

  async function save(): Promise<void> {
    setBusy('save');
    setFeedback(null);
    try {
      const next = unwrap(await window.kaiDesktop.saveOpenPencil({ endpoint: endpoint.trim(), enabled, ...(token.trim() ? { token: token.trim() } : {}) }));
      setStatus(next);
      setToken('');
      setFeedback({ ok: true, message: next.enabled ? 'Saved. Use Test connection to check the editor answers.' : 'Saved. The connection is off.' });
    } catch (caught) {
      setFeedback({ ok: false, message: caught instanceof Error ? caught.message : 'Could not save the open-pencil settings.' });
    } finally {
      setBusy(null);
    }
  }

  async function test(): Promise<void> {
    setBusy('test');
    setFeedback(null);
    try {
      const result = unwrap(await window.kaiDesktop.testOpenPencil());
      setFeedback({ ok: result.ok, message: result.message });
    } catch (caught) {
      setFeedback({ ok: false, message: caught instanceof Error ? caught.message : 'The test failed.' });
    } finally {
      setBusy(null);
    }
  }

  const unsaved = status !== null && (status.endpoint !== endpoint.trim() || status.enabled !== enabled || token.trim() !== '');

  return (
    <section className="settings-section span-two" id="settings-open-pencil">
      <div className="section-title"><PenTool size={17} /><span>open-pencil (design editor)</span></div>
      <p className="settings-note">
        Connects KAI to the open-pencil design editor over MCP. The Project Studio then pulls the tokens, components and screens you draw there, and KAI agents can draw screens in it from a prompt. Start the editor with an <code>OPENPENCIL_MCP_AUTH_TOKEN</code> and enter the same value here.
      </p>
      <label className="toggle-row">
        <span><strong>Connect to open-pencil</strong><small>{status?.tokenStored ? 'A token is stored in the OS vault' : 'No token stored yet'}</small></span>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      </label>
      <div className="field-grid">
        <label className="field"><span>MCP address</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={OPENPENCIL_ENDPOINT} spellCheck={false} /></label>
        <label className="field"><span>Auth token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={status?.tokenStored ? 'Stored. Type a new one to replace it' : 'The OPENPENCIL_MCP_AUTH_TOKEN value'} autoComplete="off" /></label>
      </div>
      <div className="button-row align-start">
        <button type="button" className="primary-button" onClick={() => void save()} disabled={busy !== null || !endpoint.trim() || !unsaved}>
          {busy === 'save' ? <Loader2 className="spin" size={15} /> : <KeyRound size={15} />}
          <span>Save open-pencil settings</span>
        </button>
        <button type="button" className="secondary-button" onClick={() => void test()} disabled={busy !== null || unsaved || !status?.enabled}>
          {busy === 'test' ? <Loader2 className="spin" size={15} /> : <PlugZap size={15} />}
          <span>Test connection</span>
        </button>
        {status?.enabled && status.tokenStored && !unsaved && !feedback && <span className="settings-note"><Check size={13} /> Connected settings saved</span>}
      </div>
      {feedback && <p className={`settings-feedback ${feedback.ok ? 'success' : 'error'}`} role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p>}
    </section>
  );
}
