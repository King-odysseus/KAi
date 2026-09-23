import { normalizeReleaseNotes, type UpdateState } from '@kai/contracts';
import { redactText } from '@kai/runtime';

/** The part of electron-updater's `autoUpdater` this controller uses, so tests can stand in for it. */
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded' | 'download-progress' | 'error', listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateControllerOptions {
  currentVersion: string;
  /** False for development runs and unpackaged builds, which have no release feed. */
  enabled: boolean;
  /** Saves a configuration backup; installing is refused if this fails. Returns the backup's name. */
  backup: (name: string) => Promise<string>;
  onChange: (state: UpdateState) => void;
  now?: () => Date;
}

/**
 * Checks for, downloads and installs releases, one explicit step at a time. Nothing is downloaded
 * or installed without the user asking, and installing first backs up the app's configuration.
 */
export class UpdateController {
  private state: UpdateState;
  private readonly now: () => Date;

  constructor(private readonly port: UpdaterPort, private readonly options: UpdateControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.state = this.make(options.enabled ? 'idle' : 'disabled', {
      message: options.enabled ? null : 'Updates are only available in installed builds.',
    });
    // The user decides when to download and when to install.
    port.autoDownload = false;
    port.autoInstallOnAppQuit = false;
    port.on('update-available', (info: { version?: string; releaseNotes?: unknown }) => {
      this.set('available', { version: info.version ?? null, notes: normalizeReleaseNotes(info.releaseNotes), checkedAt: this.now().toISOString(), message: null });
    });
    port.on('update-not-available', () => {
      this.set('none', { version: null, notes: null, checkedAt: this.now().toISOString(), message: 'You are on the latest version.' });
    });
    port.on('download-progress', (progress: { percent?: number }) => {
      this.set('downloading', { percent: Math.max(0, Math.min(100, Math.round(progress.percent ?? 0))) });
    });
    port.on('update-downloaded', () => {
      this.set('ready', { percent: 100, message: 'Ready to install. KAI will restart.' });
    });
    port.on('error', (error: unknown) => {
      this.set('error', { message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400), percent: null });
    });
  }

  getState(): UpdateState {
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (!this.options.enabled) return this.state;
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.state;
    // A downloaded update is kept; checking again must not throw it away.
    if (this.state.status === 'ready') return this.state;
    this.set('checking', { message: null, percent: null });
    try {
      await this.port.checkForUpdates();
    } catch (error) {
      this.set('error', { message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400) });
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available') return this.state;
    this.set('downloading', { percent: 0, message: null });
    try {
      await this.port.downloadUpdate();
    } catch (error) {
      this.set('error', { message: redactText(error instanceof Error ? error.message : String(error)).slice(0, 400) });
    }
    return this.state;
  }

  /** Back up the configuration, then restart into the new version. If the backup fails, nothing is installed. */
  async installAndRestart(): Promise<UpdateState> {
    if (this.state.status !== 'ready') return this.state;
    try {
      const backupName = await this.options.backup(`Before update to ${this.state.version ?? 'new version'}`);
      this.set('ready', { backupName });
    } catch (error) {
      this.set('error', { message: `The configuration backup failed, so the update was not installed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) });
      return this.state;
    }
    this.port.quitAndInstall(false, true);
    return this.state;
  }

  private make(status: UpdateState['status'], patch: Partial<UpdateState> = {}): UpdateState {
    return {
      status,
      currentVersion: this.options.currentVersion,
      version: null,
      notes: null,
      percent: null,
      message: null,
      checkedAt: null,
      backupName: null,
      ...patch,
    };
  }

  private set(status: UpdateState['status'], patch: Partial<UpdateState> = {}): void {
    this.state = { ...this.state, ...patch, status };
    this.options.onChange(this.state);
  }
}
