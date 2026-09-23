import type {
  AppSettings,
  ConversationRecord,
  ProjectPreferences,
  ProjectRecord,
} from './domain';
import type { LogEntry } from './primitives';

export interface LoggerPort {
  debug(category: LogEntry['category'], message: string, detail?: string): void;
  info(category: LogEntry['category'], message: string, detail?: string): void;
  warn(category: LogEntry['category'], message: string, detail?: string): void;
  error(category: LogEntry['category'], message: string, detail?: string, error?: unknown): void;
  recent(count?: number): LogEntry[];
}

export interface AtomicFileSystemPort {
  mkdir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export interface SettingsPort {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

export interface ProjectStorePort {
  list(): Promise<ProjectRecord[]>;
  save(project: ProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  preferences(projectId: string): Promise<ProjectPreferences | null>;
  savePreferences(preferences: ProjectPreferences): Promise<void>;
}

export interface ConversationStorePort {
  list(): Promise<ConversationRecord[]>;
  get(id: string): Promise<ConversationRecord | null>;
  save(conversation: ConversationRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CredentialStorePort {
  isAvailable(): boolean;
  has(id: string): Promise<boolean>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface DiffRequest {
  projectPath: string;
  filePath: string;
  currentContent: string;
  proposedContent: string;
}

export interface DiffPreview {
  filePath: string;
  unifiedDiff: string;
  added: number;
  removed: number;
  currentFingerprint: string;
}

export interface DiffReviewPort {
  preview(request: DiffRequest): Promise<DiffPreview>;
  apply(request: DiffRequest, expectedFingerprint: string): Promise<void>;
}

export interface NotificationRequest {
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

export interface NotificationPort {
  notify(request: NotificationRequest): Promise<void>;
}

export interface ServiceLifecyclePort {
  status(kind: 'cognitive1' | 'universalProxy'): Promise<{
    status: string;
    detail: string;
    endpoint: string | null;
  }>;
  start(kind: 'cognitive1' | 'universalProxy'): Promise<void>;
  stop(kind: 'cognitive1' | 'universalProxy'): Promise<void>;
  restart(kind: 'cognitive1' | 'universalProxy'): Promise<void>;
}
