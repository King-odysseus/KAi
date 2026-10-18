import { ARTIFACT_KINDS, CARD_KINDS, type StudioPlanAction } from '@kai/contracts';
import type { ReactNode } from 'react';

/**
 * One proposed Studio change, made editable before it is applied.
 *
 * The chat proposes; this is where the person corrects the proposal instead of discarding it and asking again.
 * Every field is the one the action actually carries, so an edit cannot invent a shape the apply path does not
 * understand.
 */
export function PlanActionEditor({ action, onChange, disabled }: {
  action: StudioPlanAction;
  onChange: (next: StudioPlanAction) => void;
  disabled: boolean;
}): ReactNode {
  const update = (patch: Record<string, unknown>): void => onChange({ ...action, ...patch } as StudioPlanAction);
  const lines = (value: string): string[] => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const text = (items: readonly string[]): string => items.join('\n');

  return (
    <div className="plan-action-editor">
      <label>
        Summary
        <input value={action.summary} onChange={(event) => update({ summary: event.target.value })} disabled={disabled} />
      </label>

      {action.kind === 'add' && (
        <>
          <label>
            Title
            <input value={action.title} onChange={(event) => update({ title: event.target.value })} disabled={disabled} />
          </label>
          <label>
            Card kind
            <select value={action.cardKind} onChange={(event) => update({ cardKind: event.target.value })} disabled={disabled}>
              {CARD_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </label>
          <label>
            Route
            <input value={action.route} onChange={(event) => update({ route: event.target.value })} placeholder="/parent" disabled={disabled} />
          </label>
          <label>
            Story
            <textarea value={action.story} onChange={(event) => update({ story: event.target.value })} rows={2} disabled={disabled} />
          </label>
          <label>
            Acceptance criteria, one per line
            <textarea value={text(action.acceptance)} onChange={(event) => update({ acceptance: lines(event.target.value) })} rows={3} disabled={disabled} />
          </label>
          <label>
            Depends on, one title or id per line
            <textarea value={text(action.dependsOn)} onChange={(event) => update({ dependsOn: lines(event.target.value) })} rows={2} disabled={disabled} />
          </label>
          {action.cardKind === 'page' && (
            <label>
              Drawn page name, when it is already in open-pencil
              <input value={action.designName ?? ''} onChange={(event) => update({ designName: event.target.value.trim() || null })} disabled={disabled} />
            </label>
          )}
        </>
      )}

      {action.kind === 'story' && (
        <>
          <label>
            Story title
            <input value={action.title} onChange={(event) => update({ title: event.target.value })} disabled={disabled} />
          </label>
          <label>
            Story
            <textarea value={action.body} onChange={(event) => update({ body: event.target.value })} rows={4} disabled={disabled} />
          </label>
          <label>
            Acceptance criteria, one per line
            <textarea value={text(action.acceptance)} onChange={(event) => update({ acceptance: lines(event.target.value) })} rows={3} disabled={disabled} />
          </label>
        </>
      )}

      {action.kind === 'link' && (
        <>
          <label>
            Drawn page name
            <input value={action.designName} onChange={(event) => update({ designName: event.target.value })} disabled={disabled} />
          </label>
          <label>
            Planned screen
            <input value={action.screenName} onChange={(event) => update({ screenName: event.target.value })} disabled={disabled} />
          </label>
        </>
      )}

      {action.kind === 'remove' && (
        <>
          <label>
            Screen
            <input value={action.screenName} onChange={(event) => update({ screenName: event.target.value })} disabled={disabled} />
          </label>
          <label className="plan-action-check">
            <input type="checkbox" checked={action.deletePage} onChange={(event) => update({ deletePage: event.target.checked })} disabled={disabled} />
            Delete the drawing in open-pencil too
          </label>
        </>
      )}

      {action.kind === 'route' && (
        <>
          <label>
            Screen
            <input value={action.screenName} onChange={(event) => update({ screenName: event.target.value })} disabled={disabled} />
          </label>
          <label>
            Route
            <input value={action.route} onChange={(event) => update({ route: event.target.value })} placeholder="/parent" disabled={disabled} />
          </label>
        </>
      )}

      {action.kind === 'generate' && (
        <div className="plan-action-artifacts">
          {ARTIFACT_KINDS.filter((kind) => kind !== 'brief').map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={action.artifacts.includes(kind)}
                onChange={(event) => update({
                  artifacts: event.target.checked
                    ? [...action.artifacts, kind]
                    : action.artifacts.filter((item) => item !== kind),
                })}
                disabled={disabled}
              />
              {kind}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
