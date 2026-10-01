import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Play, RefreshCw, SlidersHorizontal, Wrench } from 'lucide-react';
import {
  inferTarget,
  sortDifferences,
  type EqualizerReference,
  type EqualizerReport,
  type EqualizerScreen,
  type EqualizerScreens,
  type EqualizerScreenResult,
  type EqualizerTarget,
} from '@kai/contracts';
import { allDifferences, buildFixPrompt, differenceKey, reportSummary } from '../equalizer-prompt';
import { unwrap } from '../types';

/**
 * The Equalizer, in the composer. Pick where the live page comes from and what to match, run it, read the report,
 * and only then choose what to fix. Nothing in this panel changes the project: a fix is a prompt handed to the
 * composer, which the user still has to send.
 */

const TARGET_LABELS: Record<EqualizerTarget, { label: string; hint: string }> = {
  dev: { label: 'My dev server', hint: 'KAI starts the project\'s dev script and waits for it' },
  production: { label: 'Production link', hint: 'Open the live site at a link you give' },
  design: { label: 'Design only', hint: 'No live page: check that the design itself is complete' },
};

export function EqualizerPanel({ projectId, message, onFix }: {
  projectId: string;
  /** What the user has typed in the composer, which can say whether they mean dev or production. */
  message: string;
  onFix: (prompt: string) => void;
}): ReactNode {
  const [available, setAvailable] = useState<EqualizerScreens | null>(null);
  const [chosenTarget, setChosenTarget] = useState<EqualizerTarget | null>(null);
  const [reference, setReference] = useState<EqualizerReference>('open-pencil');
  const [liveUrl, setLiveUrl] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [rounds, setRounds] = useState(3);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<EqualizerReport | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const inferred = useMemo(() => inferTarget(message), [message]);
  const target: EqualizerTarget = chosenTarget ?? inferred ?? 'dev';

  useEffect(() => {
    let cancelled = false;
    setAvailable(null);
    setReport(null);
    void window.kaiDesktop.equalizerScreens(projectId).then(unwrap).then((next) => {
      if (cancelled) return;
      setAvailable(next);
      setSelected(new Set(next.screens.map((screen) => screen.name)));
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not read the screens.');
    });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => window.kaiDesktop.onEqualizerProgress((payload) => {
    if (payload.projectId === projectId) setProgress({ done: payload.done, total: payload.total, current: payload.current });
  }), [projectId]);

  const screens: EqualizerScreen[] = available?.screens ?? [];
  const chosenScreens = screens.filter((screen) => selected.has(screen.name));
  const needsLiveUrl = target === 'production' && !liveUrl.trim();
  const needsReferenceUrl = target !== 'design' && reference === 'website' && !referenceUrl.trim();
  const unroutable = target !== 'design' && chosenScreens.some((screen) => !screen.route);
  const canRun = !running && chosenScreens.length > 0 && !needsLiveUrl && !needsReferenceUrl;

  const summary = target === 'design'
    ? `Design only, ${chosenScreens.length} screen${chosenScreens.length === 1 ? '' : 's'}, report first`
    : `${TARGET_LABELS[target].label} compared with ${reference === 'open-pencil' ? 'open-pencil' : 'a website'}, ${chosenScreens.length} screen${chosenScreens.length === 1 ? '' : 's'}, report first`;

  async function run(round: number): Promise<void> {
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const next = unwrap(await window.kaiDesktop.runEqualizer({
        projectId,
        target,
        reference,
        ...(target === 'production' ? { liveUrl: liveUrl.trim() } : {}),
        ...(target !== 'design' && reference === 'website' ? { referenceUrl: referenceUrl.trim() } : {}),
        screens: chosenScreens,
        round,
        rounds,
      }));
      setReport(next);
      setTicked(allDifferences(next));
      setOpen(new Set(next.screens.filter((screen) => screen.differences.length > 0 || screen.error).slice(0, 1).map((screen) => screen.name)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Equalizer could not run.');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  const fixAll = (): void => {
    if (!report) return;
    const prompt = buildFixPrompt(report, allDifferences(report));
    if (prompt) onFix(prompt);
  };
  const fixTicked = (): void => {
    if (!report) return;
    const prompt = buildFixPrompt(report, ticked);
    if (prompt) onFix(prompt);
  };

  return (
    <section className="equalizer-panel" aria-label="Equalizer">
      <header>
        <strong><SlidersHorizontal size={14} /> Equalizer</strong>
        <span className="studio-note">Compares built screens with their design and reports every difference. It changes nothing until you choose.</span>
      </header>

      <div className="equalizer-grid">
        <fieldset>
          <legend>Live page</legend>
          {(Object.keys(TARGET_LABELS) as EqualizerTarget[]).map((item) => (
            <label key={item} className="equalizer-choice" title={TARGET_LABELS[item].hint}>
              <input type="radio" name="equalizer-target" checked={target === item} onChange={() => setChosenTarget(item)} />
              <span>{TARGET_LABELS[item].label}</span>
            </label>
          ))}
          {chosenTarget === null && inferred !== null && <small className="studio-note">Picked from your message.</small>}
          {target === 'production' && (
            <input className="equalizer-url" type="url" value={liveUrl} onChange={(event) => setLiveUrl(event.target.value)} placeholder="https://your-site.com" aria-label="Production link" />
          )}
          {target === 'dev' && <small className="studio-note">KAI starts the project's dev script and finds the port.</small>}
        </fieldset>

        {target !== 'design' && (
          <fieldset>
            <legend>Compare against</legend>
            <label className="equalizer-choice">
              <input type="radio" name="equalizer-reference" checked={reference === 'open-pencil'} onChange={() => setReference('open-pencil')} />
              <span>open-pencil</span>
            </label>
            <label className="equalizer-choice">
              <input type="radio" name="equalizer-reference" checked={reference === 'website'} onChange={() => setReference('website')} />
              <span>A website link</span>
            </label>
            {reference === 'website' && (
              <input className="equalizer-url" type="url" value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://site-to-match.com" aria-label="Website to match" />
            )}
          </fieldset>
        )}

        <fieldset>
          <legend>Screens</legend>
          {available === null ? (
            <small className="studio-note"><Loader2 className="spin" size={12} /> Reading the pages list…</small>
          ) : screens.length === 0 ? (
            <small className="studio-note">No pages list yet. Write the pages artifact in the Project Studio first.</small>
          ) : (
            <>
              <button type="button" className="equalizer-toggle" onClick={() => setListOpen((current) => !current)} aria-expanded={listOpen}>
                {listOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {chosenScreens.length} of {screens.length} selected
              </button>
              {listOpen && (
                <div className="equalizer-screens">
                  <span className="equalizer-screens-actions">
                    <button type="button" className="tour-link" onClick={() => setSelected(new Set(screens.map((screen) => screen.name)))}>All</button>
                    <button type="button" className="tour-link" onClick={() => setSelected(new Set())}>None</button>
                  </span>
                  {screens.map((screen) => (
                    <label key={screen.name} className="equalizer-choice">
                      <input type="checkbox" checked={selected.has(screen.name)} onChange={() => setSelected((current) => toggle(current, screen.name))} />
                      <span>{screen.name}{screen.route ? <code> {screen.route}</code> : <em> no route</em>}{available.drawn.some((name) => name.toLowerCase() === screen.name.toLowerCase()) ? '' : <small> not drawn</small>}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>If it fixes</legend>
          <label className="equalizer-choice">
            <span>Rounds</span>
            <input type="number" min={1} max={10} value={rounds} onChange={(event) => setRounds(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} aria-label="Fixing rounds" className="equalizer-rounds" />
          </label>
          <small className="studio-note">The most attempts an agent gets before it stops and reports.</small>
        </fieldset>
      </div>

      <p className="equalizer-summary">{summary}</p>
      {unroutable && <p className="studio-note">Some selected screens have no route, so they cannot be opened. They will be reported, not compared.</p>}

      <div className="equalizer-actions">
        <button type="button" className="primary-button" onClick={() => void run(0)} disabled={!canRun}>
          {running ? <Loader2 className="spin" size={14} /> : <Play size={14} />} Run the Equalizer
        </button>
        {running && progress && progress.total > 0 && (
          <span className="studio-note" role="status">{progress.current ? `Checking ${progress.current} (${progress.done + 1} of ${progress.total})…` : 'Writing the report…'}</span>
        )}
      </div>
      {error && <p className="studio-notice error" role="alert">{error}</p>}

      {report && (
        <div className="equalizer-report" aria-label="Equalizer report">
          <h3>Report{report.round > 0 ? ` · round ${report.round} of ${report.rounds}` : ''}</h3>
          <p className="studio-note">{reportSummary(report)}. Saved to <code>{report.reportPath}</code>.</p>
          {report.notes.map((note) => <p key={note} className="studio-note">{note}</p>)}
          <ul className="equalizer-results">
            {report.screens.map((screen) => (
              <ScreenResult
                key={screen.name}
                projectId={projectId}
                screen={screen}
                open={open.has(screen.name)}
                onToggle={() => setOpen((current) => toggle(current, screen.name))}
                ticked={ticked}
                onTick={(key) => setTicked((current) => toggle(current, key))}
              />
            ))}
          </ul>
          <div className="equalizer-actions">
            <button type="button" className="primary-button" onClick={fixAll} disabled={ticked.size === 0 && allDifferences(report).size === 0}><Wrench size={13} /> Fix all</button>
            <button type="button" className="secondary-button" onClick={fixTicked} disabled={ticked.size === 0}>Fix the ticked ones ({ticked.size})</button>
            <button type="button" className="secondary-button" onClick={() => void run(report.round + 1)} disabled={running || report.round >= report.rounds} title={report.round >= report.rounds ? 'You allowed this many rounds. Raise the number to go on.' : 'Measure again after a fix'}>
              <RefreshCw size={13} /> Re-check
            </button>
            <button type="button" className="secondary-button" onClick={() => setReport(null)}>Leave it</button>
          </div>
          <p className="studio-note">Fix puts a prompt in the composer for you to read and send. Run Re-check after the agent has finished.</p>
        </div>
      )}
    </section>
  );
}

const STATUS_LABELS: Record<EqualizerScreenResult['status'], string> = {
  match: 'Matches',
  differs: 'Differs',
  error: 'Could not check',
  'not-drawn': 'Not drawn',
  'not-listed': 'Not in the list',
};

function ScreenResult({ projectId, screen, open, onToggle, ticked, onTick }: {
  projectId: string;
  screen: EqualizerScreenResult;
  open: boolean;
  onToggle: () => void;
  ticked: ReadonlySet<string>;
  onTick: (key: string) => void;
}): ReactNode {
  const count = screen.differences.length;
  return (
    <li className={`equalizer-result ${screen.status}`}>
      <button type="button" className="equalizer-result-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <strong>{screen.name}</strong>
        {screen.route && <code>{screen.route}</code>}
        <span className={`studio-kind ${screen.status}`}>{STATUS_LABELS[screen.status]}{count > 0 ? ` · ${count}` : ''}</span>
        {screen.status === 'match' && <Check size={13} />}
      </button>
      {open && (
        <div className="equalizer-result-body">
          {screen.error && <p className="studio-notice error">{screen.error}</p>}
          {(screen.images.reference || screen.images.live || screen.images.difference) && (
            <div className="equalizer-images">
              {([['Reference', screen.images.reference], ['Live', screen.images.live], ['Difference', screen.images.difference]] as const).map(([label, path]) => (
                <figure key={label}><EqualizerImage projectId={projectId} path={path} /><figcaption>{label}</figcaption></figure>
              ))}
            </div>
          )}
          {screen.pixelDifference !== null && <p className="studio-note">{(screen.pixelDifference * 100).toFixed(1)}% of pixels differ.</p>}
          <ul className="equalizer-differences">
            {sortDifferences(screen.differences).map((difference) => {
              const key = differenceKey(screen.name, difference.id);
              return (
                <li key={difference.id} className={difference.severity}>
                  <label>
                    <input type="checkbox" checked={ticked.has(key)} onChange={() => onTick(key)} />
                    <span className={`equalizer-severity ${difference.severity}`}>{difference.severity}</span>
                    <span>{difference.message}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

function EqualizerImage({ projectId, path }: { projectId: string; path: string | null }): ReactNode {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    if (!path) return undefined;
    void window.kaiDesktop.equalizerImage({ projectId, path }).then(unwrap).then((data) => { if (!cancelled) setSource(data); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, path]);
  return source ? <img src={source} alt="" /> : <span className="equalizer-noimage">{path ? 'Loading…' : 'None'}</span>;
}
