import { safeStorage } from 'electron';
import { z } from 'zod';
import { AtomicJsonStore, type NodeFileSystem } from '@kai/runtime';

const credentialVaultSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.record(z.string()),
  })
  .strict();

type CredentialVaultRecord = z.infer<typeof credentialVaultSchema>;

/** OS-encrypted secret storage with no plaintext fallback. */
export class CredentialVault {
  private readonly store: AtomicJsonStore<CredentialVaultRecord>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, fileSystem: NodeFileSystem) {
    this.store = new AtomicJsonStore({
      filePath,
      fileSystem,
      schema: credentialVaultSchema,
      defaultValue: () => ({ schemaVersion: 1, entries: {} }),
    });
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async has(id: string): Promise<boolean> {
    const vault = await this.store.load();
    return typeof vault.entries[id] === 'string' && vault.entries[id].length > 0;
  }

  async status(): Promise<string[]> {
    const vault = await this.store.load();
    return Object.keys(vault.entries).sort();
  }

  async set(id: string, value: string): Promise<void> {
    await this.enqueueMutation(async () => {
      this.assertAvailable();
      const trimmed = value.trim();
      if (!trimmed) throw new Error('Credential value cannot be empty.');
      const vault = await this.store.load();
      vault.entries[id] = safeStorage.encryptString(trimmed).toString('base64');
      await this.store.save(vault);
    });
  }

  async get(id: string): Promise<string | undefined> {
    this.assertAvailable();
    const vault = await this.store.load();
    const encrypted = vault.entries[id];
    if (!encrypted) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      throw new Error(`Stored credential ${id} could not be decrypted on this machine.`);
    }
  }

  async delete(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const vault = await this.store.load();
      delete vault.entries[id];
      await this.store.save(vault);
    });
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error('OS credential encryption is unavailable. KAI will not store credentials as plaintext.');
    }
  }
}
