import * as crypto from 'node:crypto';
import type { CredentialVault } from '../credential-vault';

/** Where the paired devices live in the credential vault. */
export const REMOTE_DEVICES_CREDENTIAL_ID = 'remote.gateway.devices';
/** The single token the first version of the gateway kept. Read once, to adopt it as a device, never written. */
export const LEGACY_REMOTE_TOKEN_CREDENTIAL_ID = 'remote.gateway.token';

const MAX_DEVICES = 20;

/** One paired phone. The token is the device's own, so revoking one leaves the others working. */
export interface RemoteDevice {
  id: string;
  label: string;
  token: string;
  createdAt: string;
}

/** What a list may show. Deliberately without the token: listing devices must not hand them out. */
export interface RemoteDeviceSummary {
  id: string;
  label: string;
  createdAt: string;
}

export function summarise(device: RemoteDevice): RemoteDeviceSummary {
  return { id: device.id, label: device.label, createdAt: device.createdAt };
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function isDevice(value: unknown): value is RemoteDevice {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.label === 'string'
    && typeof candidate.token === 'string' && candidate.token.length > 0
    && typeof candidate.createdAt === 'string';
}

/**
 * The secrets standing between the local network and KAI's handlers, one per paired device.
 *
 * A single shared token meant the only way to un-pair one phone was to re-pair all of them, so the
 * store keeps a list instead. It lives in the same vault as every provider key, so the tokens are
 * OS-encrypted rather than written as plaintext.
 */
export class RemoteTokenStore {
  constructor(private readonly vault: CredentialVault) {}

  /** Every paired device, oldest first. A hand-edited or corrupt entry is dropped rather than trusted. */
  async list(): Promise<RemoteDevice[]> {
    if (!this.vault.isAvailable()) return [];
    const raw = await this.vault.get(REMOTE_DEVICES_CREDENTIAL_ID);
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const devices = parsed.filter(isDevice);
          // A device minted by the version before this one: adopt it so an existing phone keeps working.
          if (devices.length > 0) return devices;
        }
      } catch {
        // Fall through to the legacy token, then to an empty list.
      }
    }
    const legacy = await this.vault.get(LEGACY_REMOTE_TOKEN_CREDENTIAL_ID);
    if (!legacy) return [];
    return [{ id: 'device-1', label: 'Paired phone', token: legacy, createdAt: new Date().toISOString() }];
  }

  /** The stored devices, minting the first one on demand so enabling the gateway needs no separate step. */
  async ensure(): Promise<RemoteDevice[]> {
    const devices = await this.list();
    if (devices.length > 0) {
      await this.persist(devices);
      return devices;
    }
    return this.persist([this.mint('First device')]);
  }

  /** A new device with its own token. Pairing a phone never disturbs a phone that is already paired. */
  async create(label: string): Promise<RemoteDevice> {
    const devices = await this.ensure();
    const device = this.mint(label.trim() || 'Unnamed device');
    return this.persist([...devices, device]).then((next) => next[next.length - 1]!);
  }

  async revoke(id: string): Promise<RemoteDevice[]> {
    const devices = await this.list();
    return this.persist(devices.filter((device) => device.id !== id));
  }

  /**
   * The device a presented token belongs to, or null. Every stored token is compared, with no early exit:
   * a wrong guess must not be distinguishable from a wrong guess against a different device.
   */
  async verify(presented: string): Promise<RemoteDevice | null> {
    const devices = await this.list();
    let found: RemoteDevice | null = null;
    for (const device of devices) {
      if (tokensMatch(presented, device.token)) found = device;
    }
    return found;
  }

  private mint(label: string): RemoteDevice {
    return {
      id: crypto.randomBytes(6).toString('hex'),
      label: label.slice(0, 60),
      token: newToken(),
      createdAt: new Date().toISOString(),
    };
  }

  private async persist(devices: RemoteDevice[]): Promise<RemoteDevice[]> {
    // Oldest first, so the cap drops the longest-unused pairing rather than the newest.
    const kept = devices.slice(-MAX_DEVICES);
    await this.vault.set(REMOTE_DEVICES_CREDENTIAL_ID, JSON.stringify(kept));
    // The legacy key is only a source to adopt from; leaving it behind would keep a token alive that the
    // device list no longer shows, which is exactly the state per-device tokens exist to remove.
    await this.vault.delete(LEGACY_REMOTE_TOKEN_CREDENTIAL_ID);
    return kept;
  }
}

/**
 * Constant-time comparison that does not leak the token's length: both sides are hashed first, so the
 * comparison is always 32 bytes and a wrong-length guess costs the same as a wrong-value one.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Pulls the token out of an `Authorization: Bearer <token>` header, or null when absent or malformed. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim() : null;
}
