import { Check, Copy, KeyRound, RefreshCw, Smartphone, Trash2, Wifi } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type {
  AppSettings,
  RemoteAccessSettings,
  RemoteAccessStatus,
  RemoteDeviceSummary,
  RemoteTokenResult,
  SettingsUpdate,
} from '@kai/contracts';
import { unwrap } from '../types';
import { UiButton } from './UiButton';
import { Checkbox } from 'flowbite-react';
import { UiTextInput } from './UiTextInput';

/**
 * Settings for KAI Remote. Saving here takes effect immediately: main-process `settings:update` starts,
 * stops or moves the gateway, so the status line below reflects the change without a restart.
 */
export function RemoteAccessPanel({ settings, onSave, busy }: {
  settings: AppSettings;
  onSave: (update: SettingsUpdate) => Promise<boolean>;
  busy: boolean;
}): ReactNode {
  const [remote, setRemote] = useState<RemoteAccessSettings>(settings.remote);
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [revealed, setRevealed] = useState<RemoteTokenResult | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceSummary[]>([]);
  const [label, setLabel] = useState('Phone');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => setRemote(settings.remote), [settings.remote]);

  async function refresh(): Promise<void> {
    const response = await window.kaiDesktop.remoteStatus();
    if (response.ok) setStatus(response.data);
  }

  async function loadDevices(): Promise<void> {
    const response = await window.kaiDesktop.remoteDevices();
    if (response.ok) setDevices(response.data);
  }

  useEffect(() => {
    void refresh();
    // Only worth asking once the gateway is on: with it off there is nothing paired to show.
    if (settings.remote.enabled) void loadDevices();
  }, [settings.remote]);

  async function save(next: RemoteAccessSettings): Promise<void> {
    setError(null);
    setRemote(next);
    const saved = await onSave({ remote: next });
    if (!saved) setError('That change could not be saved.');
    await refresh();
  }

  async function pair(): Promise<void> {
    setError(null);
    setWorking(true);
    try {
      setRevealed(unwrap(await window.kaiDesktop.pairRemoteDevice(label)));
      setCopied(null);
      await loadDevices();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'A new token could not be created.');
    } finally {
      setWorking(false);
      await refresh();
    }
  }

  async function revoke(id: string): Promise<void> {
    setError(null);
    setWorking(true);
    try {
      setDevices(unwrap(await window.kaiDesktop.revokeRemoteDevice(id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That device could not be removed.');
    } finally {
      setWorking(false);
    }
  }

  function copy(key: string, value: string): void {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2_000);
    });
  }

  // The phone has no field to type a token into: the link is how it is paired, and the token is taken
  // out of the address bar as soon as the page reads it.
  const address = revealed?.urls[0];
  const pairingLink = address ? `${address}/mobile/?token=${encodeURIComponent(revealed!.token)}` : null;
  // A loopback link is a real link, but only from this machine — the phone cannot resolve it.
  const reachable = Boolean(address) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(address!);

  // What a phone would type. Shown whether or not LAN mode is on, because knowing the address is what
  // lets the user decide about the switch. `/mobile/` is served without a token on purpose, so typing it
  // by hand lands on the page that explains how to pair.
  const lanUrl = status?.lanUrl ?? null;
  const phoneUrl = lanUrl ? `${lanUrl}/mobile/` : null;
  const phoneHint = !lanUrl
    ? 'This machine has no private network address, so a phone on the network cannot reach it.'
    : !remote.lanEnabled
      ? 'Turn on network access above to open this from the phone.'
      : status?.running
        ? 'On the same network as this machine. It asks to be paired the first time. Installing it on the home screen needs an HTTPS address — over http it stays a browser tab.'
        : 'Network access is on, but nothing is listening yet.';

  const disabled = busy || working;
  return (
    <section className="settings-section span-two">
      <div className="section-title"><Smartphone size={17} /><span>KAI Remote</span></div>
      <p className="settings-note">A phone-sized console for this desktop, served over your own network. Watch a run, answer an approval and keep a conversation going without walking back to the desk.</p>

      <label className="toggle-row">
        <span><strong>KAI Remote</strong><small>Serves a small web app on this machine for your phone.</small></span>
        <Checkbox disabled={disabled} checked={remote.enabled} onChange={(event) => void save({ ...remote, enabled: event.target.checked })} />
      </label>

      {!remote.enabled && phoneUrl && (
        <p className="settings-note">Once it is on, a phone on this network opens <code>{phoneUrl}</code>.</p>
      )}

      {remote.enabled && (
        <>
          <div className={`vault-state ${status?.running ? 'ready' : 'unavailable'}`}>
            <Smartphone size={18} />
            <div>
              <strong>{status?.running ? 'Listening' : 'Not listening'}</strong>
              <small>{status?.running ? status.urls.join(' · ') : status?.lastError ?? 'Starting…'}</small>
            </div>
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void refresh()} title="Refresh status">
              <RefreshCw size={14} />
            </UiButton>
          </div>

          <label className="toggle-row">
            <span>
              <strong>Allow other devices on this network</strong>
              <small>Off means only this machine can reach it. On binds your private network address — never 0.0.0.0.</small>
            </span>
            <Checkbox disabled={disabled} checked={remote.lanEnabled} onChange={(event) => void save({ ...remote, lanEnabled: event.target.checked })} />
          </label>
          {remote.lanEnabled && (
            <p className="settings-note"><strong>Any device on this network that has the token can run your agents, read your files and start commands.</strong> Only turn this on where you trust the network.</p>
          )}

          <div className={`phone-address ${remote.lanEnabled && status?.running ? 'ready' : ''}`}>
            <Wifi size={17} />
            <div>
              <strong>Open this on the phone</strong>
              <small>{phoneHint}</small>
            </div>
            {phoneUrl && <code>{phoneUrl}</code>}
            {phoneUrl && (
              <UiButton type="button" className="secondary-button" onClick={() => copy('address', phoneUrl)} title="Copy the phone address">
                {copied === 'address' ? <Check size={14} /> : <Copy size={14} />}
              </UiButton>
            )}
          </div>

          <div className="field-grid">
            <label className="field">
              <span>Port</span>
              <UiTextInput type="number" min={1024} max={65535} value={remote.port} disabled={disabled} onChange={(event) => setRemote({ ...remote, port: Number(event.target.value) })} onBlur={() => void save(remote)} />
            </label>
            <label className="field">
              <span>Device name</span>
              <UiTextInput type="text" maxLength={60} value={label} disabled={disabled} placeholder="Phone" onChange={(event) => setLabel(event.target.value)} />
            </label>
          </div>

          <div className="button-row align-start">
            <UiButton type="button" className="secondary-button" disabled={disabled} onClick={() => void pair()}>
              <KeyRound size={15} />
              <span>Pair a device</span>
            </UiButton>
            <span className="settings-note">Each device gets its own token, so revoking one leaves the rest working.</span>
          </div>

          {pairingLink && (
            <div className="vault-state ready">
              <KeyRound size={18} />
              <div>
                <strong>Open this link on the phone</strong>
                <small>
                  It carries the token, and is shown only here — never again after you leave this page.
                  {!reachable && ' This address is this machine only: turn on network access above to open it from a phone.'}
                </small>
              </div>
              <code>{pairingLink}</code>
              <UiButton type="button" className="secondary-button" onClick={() => copy('link', pairingLink)} title="Copy pairing link">
                {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
              </UiButton>
            </div>
          )}

          <div className="settings-subsection">
            <div className="settings-subsection-title"><KeyRound size={15} /><span>Paired devices</span></div>
            {devices.length === 0 ? (
              <p className="settings-note">No device has been paired yet. Pair one to get a link for the phone.</p>
            ) : (
              <ul className="device-list">
                {devices.map((device) => (
                  <li key={device.id} className="device-row">
                    <Smartphone size={15} />
                    <div>
                      <strong>{device.label}</strong>
                      <small>Paired {new Date(device.createdAt).toLocaleDateString()}</small>
                    </div>
                    <UiButton type="button" className="secondary-button danger" disabled={disabled} onClick={() => void revoke(device.id)} title={`Revoke ${device.label}`}>
                      <Trash2 size={14} />
                      <span>Revoke</span>
                    </UiButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && <div className="workbench-error" role="alert">{error}</div>}
          {!error && status?.lastError && <div className="workbench-error" role="alert">{status.lastError}</div>}
        </>
      )}
    </section>
  );
}
