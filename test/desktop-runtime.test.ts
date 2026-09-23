import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultSettings, type ConversationRecord } from '../packages/contracts/src';
import {
  ConversationStore,
  NodeFileSystem,
  RedactedLogger,
  SettingsService,
  redactObject,
  redactText,
} from '../packages/runtime/src';
import { ProjectPreferenceStore } from '../apps/desktop/src/main/project-preference-store';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kai-desktop-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('portable desktop runtime', () => {
  it('persists settings and reloads them without a VS Code dependency', async () => {
    const directory = await temporaryDirectory();
    const service = new SettingsService(path.join(directory, 'settings.json'), new NodeFileSystem());
    const settings = createDefaultSettings();
    settings.defaultAgent = 'gemini';

    await service.save(settings);
    await expect(service.load()).resolves.toEqual(settings);
  });

  it('persists conversation records with atomic replacements', async () => {
    const directory = await temporaryDirectory();
    const store = new ConversationStore(path.join(directory, 'conversations'));
    const conversation = makeConversation('conv-1', 'First title');

    await store.save(conversation);
    conversation.title = 'Updated title';
    await store.save(conversation);

    await expect(store.get('conv-1')).resolves.toMatchObject({ title: 'Updated title' });
    await expect(store.list()).resolves.toHaveLength(1);
    await store.remove('conv-1');
    await expect(store.get('conv-1')).resolves.toBeNull();
  });

  it('persists and removes project-scoped preferences', async () => {
    const directory = await temporaryDirectory();
    const store = new ProjectPreferenceStore(
      path.join(directory, 'project-preferences.json'),
      new NodeFileSystem(),
    );

    await store.upsert({ schemaVersion: 1, projectId: 'project-1', agent: 'codex', route: 'proxy' });
    await expect(store.get('project-1')).resolves.toMatchObject({ agent: 'codex', route: 'proxy' });

    await store.remove('project-1');
    await expect(store.get('project-1')).resolves.toBeNull();
  });

  it('redacts credentials from logs and structured diagnostics', () => {
    const logger = new RedactedLogger();
    logger.error('credential_error', 'Request failed with Bearer secret-token-123456', 'apiKey=sk-abcdefgh12345678');

    expect(redactText('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(redactObject({ apiKey: 'sk-live-123456789', nested: { token: 'abc' } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]' },
    });
    expect(JSON.stringify(logger.recent())).not.toContain('secret-token-123456');
  });
});

function makeConversation(id: string, title: string): ConversationRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    projectId: null,
    title,
    createdAt: now,
    updatedAt: now,
    archived: false,
    unread: false,
    activeAgent: null,
    route: null,
    autonomy: null,
    turns: [],
    events: [],
  };
}
