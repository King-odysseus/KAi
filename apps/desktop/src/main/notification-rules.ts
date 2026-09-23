import type { NotificationKind, NotificationSettings, UsageLimitStatus } from '@kai/contracts';

export interface DesktopNotification {
  kind: NotificationKind;
  conversationId: string | null;
  title: string;
  body: string;
}

export interface NotificationCenterDeps {
  getSettings: () => Promise<NotificationSettings>;
  isWindowFocused: () => boolean;
  show: (notification: DesktopNotification) => void;
}

const SETTING_FOR_KIND: Record<NotificationKind, keyof NotificationSettings> = {
  complete: 'onComplete',
  failure: 'onFailure',
  approval: 'onApproval',
  budget: 'onBudget',
};

const MAX_BODY = 200;

function clip(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > MAX_BODY ? `${single.slice(0, MAX_BODY - 1)}…` : single;
}

/**
 * Decides when to raise native notifications and tracks active runs for the tray.
 * A notification is skipped when its type is off, or when the window is focused and
 * already showing the conversation it is about.
 */
export class NotificationCenter {
  private viewing: { view: string; conversationId: string | null } = { view: 'workspace', conversationId: null };
  private readonly activeRuns = new Set<string>();
  private readonly budgetLevels = new Map<string, UsageLimitStatus['level']>();
  private readonly runListeners = new Set<() => void>();

  constructor(private readonly deps: NotificationCenterDeps) {}

  setViewing(view: string, conversationId: string | null): void {
    this.viewing = { view, conversationId };
  }

  onRunsChanged(listener: () => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  activeRunIds(): string[] {
    return [...this.activeRuns];
  }

  runStarted(conversationId: string): void {
    this.activeRuns.add(conversationId);
    this.emitRunsChanged();
  }

  runEnded(conversationId: string): void {
    if (this.activeRuns.delete(conversationId)) this.emitRunsChanged();
  }

  async notifyRunFinished(conversationId: string, title: string, status: 'completed' | 'failed' | 'cancelled', detail?: string): Promise<boolean> {
    if (status === 'cancelled') return false;
    return status === 'completed'
      ? this.raise({ kind: 'complete', conversationId, title: 'Run finished', body: clip(title) })
      : this.raise({ kind: 'failure', conversationId, title: 'Run failed', body: clip(detail ? `${title}: ${detail}` : title) });
  }

  async notifyApproval(conversationId: string, title: string, approvalTitle: string): Promise<boolean> {
    return this.raise({ kind: 'approval', conversationId, title: 'Approval needed', body: clip(`${approvalTitle} (${title})`) });
  }

  /** Raises one notification for limits that newly reached warning or exceeded; quiet while a level holds. */
  async notifyBudget(conversationId: string | null, limits: readonly UsageLimitStatus[]): Promise<boolean> {
    let worst: UsageLimitStatus | null = null;
    for (const limit of limits) {
      const key = `${limit.scope}:${limit.provider ?? ''}`;
      const previous = this.budgetLevels.get(key) ?? 'ok';
      this.budgetLevels.set(key, limit.level);
      const rank = (level: UsageLimitStatus['level']): number => (level === 'ok' ? 0 : level === 'warning' ? 1 : 2);
      if (rank(limit.level) > rank(previous) && (!worst || rank(limit.level) > rank(worst.level))) worst = limit;
    }
    if (!worst) return false;
    const exceeded = worst.level === 'exceeded';
    return this.raise({
      kind: 'budget',
      conversationId,
      title: exceeded ? 'Budget limit reached' : 'Budget warning',
      body: `${worst.scope === 'provider' ? `${worst.provider} daily` : worst.scope} budget at ${Math.round(worst.ratio * 100)}% (estimated).`,
    });
  }

  private async raise(notification: DesktopNotification): Promise<boolean> {
    const settings = await this.deps.getSettings();
    if (!settings[SETTING_FOR_KIND[notification.kind]]) return false;
    const onScreen = this.deps.isWindowFocused()
      && this.viewing.view === 'workspace'
      && notification.conversationId !== null
      && this.viewing.conversationId === notification.conversationId;
    if (onScreen) return false;
    this.deps.show(notification);
    return true;
  }

  private emitRunsChanged(): void {
    for (const listener of this.runListeners) listener();
  }
}
