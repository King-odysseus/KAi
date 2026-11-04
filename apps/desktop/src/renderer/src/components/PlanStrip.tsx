import { Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { Plan } from '@kai/contracts';
import { unwrap } from '../types';
import { useRunPanelCollapsed } from './run-panel-collapse';
import { UiButton } from './UiButton';

/**
 * The plan the agent is working to, shown above the composer.
 *
 * It is the run's own account of what it is doing, so showing it is what makes the mechanism visible: without it the
 * plan is a file on disk and the only way to know whether the run has a thread is to infer it from behaviour.
 *
 * One line by default, because the transcript is already busy and a plan that is going well does not need room. It
 * opens to the steps when anyone wants them, and remembers that choice.
 */
/** How far the plan has got, for lines that only have room for a count. Null until the agent has written a plan. */
export function usePlanProgress(projectId: string | null, conversationId: string | null, refreshKey?: string): { done: number; total: number } | null {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!projectId || !conversationId) { setProgress(null); return undefined; }
    let cancelled = false;
    void window.kaiDesktop.readTaskPlan(projectId, conversationId).then(unwrap)
      .then((plan) => { if (!cancelled) setProgress(plan && plan.items.length > 0 ? { done: plan.items.filter((item) => item.state === 'done').length, total: plan.items.length } : null); })
      .catch(() => { if (!cancelled) setProgress(null); });
    return () => { cancelled = true; };
  }, [projectId, conversationId, refreshKey]);
  return progress;
}

export function PlanStrip({ projectId, conversationId, refreshKey }: { projectId: string | null; conversationId: string | null; refreshKey?: string }): ReactNode {
  const [collapsed, toggle] = useRunPanelCollapsed('plan', true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Cleared first: a tab switch must not show the last tab's plan while the new one is being read.
    setPlan(null);
    if (!projectId || !conversationId) return undefined;
    let cancelled = false;
    setLoading(true);
    void window.kaiDesktop.readTaskPlan(projectId, conversationId).then(unwrap)
      .then((next) => { if (!cancelled) setPlan(next); })
      .catch(() => { if (!cancelled) setPlan(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, conversationId, refreshKey]);

  // Nothing to show until the agent has written one, and an empty strip on every conversation would be noise.
  if (!projectId || !conversationId || (!plan && !loading)) return null;

  const items = plan?.items ?? [];
  const done = items.filter((item) => item.state === 'done').length;
  const active = items.find((item) => item.state === 'active');

  return (
    <section className="plan-strip" aria-label="Task plan">
      <UiButton type="button" className="plan-strip-head" onClick={toggle} aria-expanded={!collapsed}>
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span>Plan</span>
        <small>
          {loading && items.length === 0
            ? 'reading…'
            : `${done} of ${items.length} done${active ? ` · ${active.text}` : ''}`}
        </small>
        {loading && items.length === 0 ? <Loader2 className="spin" size={12} /> : null}
      </UiButton>
      {!collapsed && items.length > 0 && (
        <ol className="plan-strip-items">
          {items.map((item, index) => (
            <li key={`${index}-${item.text}`} className={`plan-item ${item.state}`}>
              <span className="plan-item-mark">{item.state === 'done' ? <Check size={11} /> : null}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
