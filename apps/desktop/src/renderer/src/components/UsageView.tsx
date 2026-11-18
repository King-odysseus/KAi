import { AlertTriangle, Check, RefreshCw, Wallet } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DIRECT_PROVIDER_ORDER, directProviderPreset, isLocalProvider } from '@kai/contracts';
import type { AppSettings, SettingsUpdate, UsageBudget, UsageLimitStatus, UsageSummary } from '@kai/contracts';
import { unwrap } from '../types';

import { Select } from './ui/Select';
import { UiButton } from './UiButton';
import { UiTextInput } from './UiTextInput';
import { PageHeader } from './ui/PageHeader';
const REFRESH_MS = 15_000;

export function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 1 ? 4 : 2)}`;
}

function limitName(limit: UsageLimitStatus): string {
  if (limit.scope === 'provider') return `${limit.provider} daily`;
  return limit.scope === 'conversation' ? 'Conversation' : limit.scope === 'daily' ? 'Daily' : 'Monthly';
}

function useUsageSummary(conversationId: string | undefined, refreshToken: unknown) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSummary(unwrap(await window.kaiDesktop.usageSummary(conversationId)));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Usage could not be loaded.');
    }
  }, [conversationId]);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);
  return { summary, error, refresh };
}

/** Shown in the workspace only when a limit reaches 80% or is used up. */
export function UsageBanner({ conversationId, refreshToken, onOpenUsage }: { conversationId: string | undefined; refreshToken: unknown; onOpenUsage: () => void }): ReactNode {
  const { summary } = useUsageSummary(conversationId, refreshToken);
  if (!summary) return null;
  const flagged = summary.limits.filter((limit) => limit.level !== 'ok');
  if (flagged.length === 0) return null;
  const worst = flagged.find((limit) => limit.level === 'exceeded') ?? flagged[0]!;
  const exceeded = worst.level === 'exceeded';
  const blocking = exceeded && summary.blocked;
  const detail = blocking
    ? 'New API requests are blocked until the limit is raised or reset.'
    : exceeded
      ? 'Warn mode is on, so requests still run.'
      : 'Approaching the limit.';
  return (
    <div className={`workbench-notice usage-banner ${exceeded ? 'exceeded' : 'warning'}`} role="status">
      <span>
        <AlertTriangle size={13} /> {limitName(worst)} budget {formatUsd(worst.spentUsd)} of {formatUsd(worst.limitUsd)} ({Math.round(worst.ratio * 100)}%, estimated). {detail}
      </span>
      <UiButton type="button" className="secondary-button" onClick={onOpenUsage}>Open Usage</UiButton>
    </div>
  );
}

export function UsageView({ settings, activeConversationId, busy, onSave }: { settings: AppSettings; activeConversationId: string | null; busy: boolean; onSave: (update: SettingsUpdate) => void | Promise<boolean | void> }): ReactNode {
  const { summary, error, refresh } = useUsageSummary(activeConversationId ?? undefined, settings.usageBudget);
  const [draft, setDraft] = useState<UsageBudget>(settings.usageBudget);
  useEffect(() => setDraft(settings.usageBudget), [settings.usageBudget]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Says so, briefly, once a save has gone through; a failed save shows nothing here (the app's error banner reports it).
  const [saved, setSaved] = useState<'budget' | 'compact' | null>(null);
  const savedTimer = useRef<number | null>(null);
  async function save(which: 'budget' | 'compact'): Promise<void> {
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    setSaved(null);
    const outcome = await onSave({ usageBudget: draft });
    if (outcome === false) return;
    setSaved(which);
    savedTimer.current = window.setTimeout(() => setSaved(null), 3_000);
  }

  const totalIn = (summary?.byProvider ?? []).reduce((sum, row) => sum + row.inputTokens, 0);
  const totalOut = (summary?.byProvider ?? []).reduce((sum, row) => sum + row.outputTokens, 0);
  // Tokens that ran on this machine or the home network: they cost nothing, which is the point of running them there.
  const localRows = (summary?.byProvider ?? []).filter((row) => isLocalProvider(row.provider as Parameters<typeof isLocalProvider>[0]));
  const localTokens = localRows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const paidProviders = DIRECT_PROVIDER_ORDER;
  const maxDay = Math.max(...(summary?.byDay.map((day) => day.usd) ?? [0]), 0.000001);
  const setLimit = (key: 'perRunUsd' | 'perConversationUsd' | 'dailyUsd' | 'monthlyUsd', value: number): void =>
    setDraft((current) => ({ ...current, [key]: Number.isFinite(value) && value >= 0 ? value : 0 }));
  const setProviderLimit = (provider: string, value: number): void =>
    setDraft((current) => {
      const next = { ...current.providerDailyUsd };
      if (Number.isFinite(value) && value > 0) next[provider] = value;
      else delete next[provider];
      return { ...current, providerDailyUsd: next };
    });

  return (
    <div className="page-view usage-view">
      <PageHeader title="Usage" detail="Estimated spend from paid API runs only. Claude and Codex subscription usage is never counted." actions={<><UiButton type="button" className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14} /><span>Refresh</span></UiButton></>} />
      {error && <div className="workbench-error" role="alert">{error}</div>}

      <div className="metric-strip usage-metrics">
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>Today (estimate)</small><strong>{formatUsd(summary?.todayUsd ?? 0)}</strong></div></div>
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>This month (estimate)</small><strong>{formatUsd(summary?.monthUsd ?? 0)}</strong></div></div>
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>Active conversation</small><strong>{summary?.conversationUsd == null ? 'None open' : formatUsd(summary.conversationUsd)}</strong></div></div>
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>Tokens used</small><strong title={`${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`}>{formatTokens(totalIn + totalOut)}</strong></div></div>
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>Kept on this machine</small><strong title="Tokens from local models: LM Studio, Ollama and the like. They cost nothing.">{localTokens >= 1_000_000 ? `${(localTokens / 1_000_000).toFixed(1)}M` : localTokens >= 1_000 ? `${Math.round(localTokens / 1_000)}k` : localTokens}</strong></div></div>
        <div className="metric"><span className="metric-icon"><Wallet size={16} /></span><div><small>Unpriced runs</small><strong>{summary?.unpricedRuns ?? 0}</strong></div></div>
      </div>
      {summary && summary.unpricedRuns > 0 && (
        <p className="settings-note">Some runs used a model with no known price, so they count as $0. Their token counts are still listed below.</p>
      )}

      <div className="usage-layout">
        <section className="settings-section usage-budget">
          <div className="section-title"><span>Budget limits</span></div>
          <p className="settings-note">Set a limit to 0 to turn it off. Warn mode shows a banner at 80% and 100%. Block mode also stops new API requests at 100%, before anything is sent. The per-run limit always stops a single direct API run that reaches it, in either mode.</p>
          <div className="usage-budget-row">
            <label className="field"><span>Mode</span><Select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as UsageBudget['mode'] })}><option value="warn">warn</option><option value="block">block</option></Select></label>
            <UsdField label="Per run (USD)" value={draft.perRunUsd} onChange={(value) => setLimit('perRunUsd', value)} />
            <UsdField label="Per conversation (USD)" value={draft.perConversationUsd} onChange={(value) => setLimit('perConversationUsd', value)} />
            <UsdField label="Per day (USD)" value={draft.dailyUsd} onChange={(value) => setLimit('dailyUsd', value)} />
            <UsdField label="Per month (USD)" value={draft.monthlyUsd} onChange={(value) => setLimit('monthlyUsd', value)} />
            <UiButton type="button" className="primary-button" disabled={busy} onClick={() => void save('budget')}><Check size={16} /><span>Save budget</span></UiButton>
            {saved === 'budget' && <span className="saved" role="status">Saved</span>}
          </div>
          <details className="usage-provider-limits">
            <summary>Daily limit per provider</summary>
            <div className="field-grid">
              {paidProviders.map((id) => (
                <UsdField key={id} label={`${directProviderPreset(id).displayName} (USD)`} value={draft.providerDailyUsd[id] ?? 0} onChange={(value) => setProviderLimit(id, value)} />
              ))}
            </div>
          </details>
          <h3 className="usage-subtitle">Limit status</h3>
          {summary && summary.limits.length > 0 ? (
            <div className="usage-limits">
              {summary.limits.map((limit) => (
                <div key={`${limit.scope}-${limit.provider ?? ''}`} className={`usage-limit ${limit.level}`}>
                  <div className="usage-limit-head"><strong>{limitName(limit)}</strong><span>{formatUsd(limit.spentUsd)} of {formatUsd(limit.limitUsd)} · {Math.round(limit.ratio * 100)}%</span></div>
                  <div className="usage-bar" role="img" aria-label={`${limitName(limit)} budget ${Math.round(limit.ratio * 100)}% used`}><span style={{ width: `${Math.min(100, limit.ratio * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-note">No limits are set. Add one above to get warnings.</p>
          )}
        </section>

        <div className="usage-side">
          <section className="settings-section usage-compact">
          <div className="section-title"><span>Auto-compact</span></div>
          <p className="settings-note">When a conversation's history reaches this many tokens, KAI summarises the older turns before the next request, in the composer, Crew, Studio and workflows alike. Local models, which have small context windows, compact at their own smaller size. Set the hosted size to 0 to never compact on its own.</p>
          <div className="usage-budget-row">
            <label className="field"><span>Hosted models: compact at (tokens)</span><small className="usage-unit-hint">{draft.compactAtTokens > 0 ? `about ${Math.round(draft.compactAtTokens * 0.75).toLocaleString()} words of history` : 'off: never compacts on its own'}</small><UiTextInput type="number" min={0} max={2000000} step={1000} value={draft.compactAtTokens} onChange={(event) => { const value = Math.floor(Number(event.target.value)); setDraft((current) => ({ ...current, compactAtTokens: Number.isFinite(value) && value >= 0 ? Math.min(value, 2_000_000) : 0 })); }} /></label>
            <label className="field"><span>Local models: compact at (tokens)</span><small className="usage-unit-hint">{draft.compactAtTokensLocal > 0 ? 'LM Studio, Ollama and other local servers' : 'off: local models use the size on the left'}</small><UiTextInput type="number" min={0} max={2000000} step={1000} value={draft.compactAtTokensLocal} onChange={(event) => { const value = Math.floor(Number(event.target.value)); setDraft((current) => ({ ...current, compactAtTokensLocal: Number.isFinite(value) && value >= 0 ? Math.min(value, 2_000_000) : 0 })); }} /></label>
            <UiButton type="button" className="primary-button" disabled={busy} onClick={() => void save('compact')}><Check size={16} /><span>Save</span></UiButton>
            {saved === 'compact' && <span className="saved" role="status">Saved: compacting at {draft.compactAtTokens > 0 ? `${draft.compactAtTokens.toLocaleString()} tokens` : 'never (off)'}</span>}
          </div>
        </section>

        <section className="settings-section usage-days">
          <div className="section-title"><span>Last 30 days</span></div>
          <div className="usage-chart" role="img" aria-label="Estimated daily spend for the last 30 days">
            {(summary?.byDay ?? []).map((day) => (
              <span key={day.day} className="usage-chart-bar" title={`${day.day}: ${formatUsd(day.usd)}`} style={{ height: `${Math.max(2, (day.usd / maxDay) * 100)}%` }} />
            ))}
          </div>
        </section>
        </div>

        <UsageTable title="By provider" empty="No paid API runs yet" rows={(summary?.byProvider ?? []).map((row) => ({ name: row.provider, usd: formatUsd(row.usd), detail: `${row.runs} runs · ${row.inputTokens.toLocaleString()} in / ${row.outputTokens.toLocaleString()} out` }))} />
        <UsageTable title="By model" empty="No paid API runs yet" rows={(summary?.byModel ?? []).map((row) => ({ name: row.model, usd: formatUsd(row.usd), detail: `${row.provider} · ${row.runs} runs · ${row.inputTokens.toLocaleString()} in / ${row.outputTokens.toLocaleString()} out` }))} />
        <UsageTable title="Top conversations" empty="No paid API runs yet" rows={(summary?.byConversation ?? []).map((row) => ({ name: row.title || row.conversationId, usd: formatUsd(row.usd) }))} />
      </div>
    </div>
  );
}

/** 1,234 as "1.2K", 2,500,000 as "2.5M": the table rows carry the exact counts. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function UsdField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): ReactNode {
  return <label className="field"><span>{label}</span><UiTextInput type="number" min={0} step={0.5} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function UsageTable({ title, rows, empty }: { title: string; rows: Array<{ name: string; usd: string; detail?: string }>; empty: string }): ReactNode {
  return (
    <section className="settings-section usage-table-card">
      <div className="section-title"><span>{title}</span></div>
      {rows.length === 0 ? <p className="settings-note">{empty}</p> : (
        <ul className="usage-rows">
          {rows.slice(0, 8).map((row) => (
            <li key={row.name} title={row.detail}><span className="truncate">{row.name}</span><strong>{row.usd}</strong></li>
          ))}
        </ul>
      )}
    </section>
  );
}
