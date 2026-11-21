import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Cpu, Loader2, MessageCircle, Sparkles } from 'lucide-react';
import type { AgentCapability, AgentId, CodeGuideAction, CodeGuideView, ConversationRecord, GuidedBuild, GuidedBuildStep, RoleTarget } from '@kai/contracts';
import { directProviderPreset } from '@kai/contracts';
import { Composer, ComposerInput, ComposerSend, ComposerToolbar } from './ui/Composer';
import { OptionMenu } from './ui/OptionMenu';
import { UiButton } from './UiButton';
import { CUSTOM_ROLE_MODEL, roleModelOptions, targetFromValue, targetOptions, targetValue, withModel } from './architect-settings';
import { promptDialog } from './AppDialog';
import { Markdown } from './Markdown';
import { parseGuidedBuildObject, visibleGuidedBuildReply } from './guided-build-format';
import { GuidedBuildCard } from './GuidedBuildCard';
import { GuidedBuildTeamPanel } from './GuidedBuildTeamPanel';
import { collectCheck, collectDiffs } from './guided-build-evidence';
import { startingTargets } from '../model-team';
import { useDirectApiModels } from '../use-direct-api-models';
import { stepModelChoices, mergePlanProgress, withSettingsModel, guidedUsage, addIdeaPrompt, builderStepPrompt, builderStuckReason, coachPrompt, describeRole, diffText, evidenceText, gateReview, guidedTurnIndexes, learnPrompt, localBuilderStepPrompt, planFromBriefPrompt, planPrompt as buildPlanPrompt, readGuidedPlan, readGuidedReview, reviewPrompt, showCodePrompt, writeCodePrompt, type CheckEvidence, type GuidedRunOverride, type LearnAction } from './guided-build-engine';
import { unwrap } from '../types';

type BuildMode = 'coach' | 'plan' | 'review' | 'show-code' | 'write-code';

export function GuidedBuildLearnPanel(props: {
  view: CodeGuideView | null;
  explaining: boolean;
  busy: boolean;
  error: string | null;
  onExplain: () => void;
  onAction: (action: CodeGuideAction) => void;
  stripHidden: boolean;
  onToggleStrip: () => void;
  guidedBuild: GuidedBuild | null;
  conversation: ConversationRecord | null;
  agentCapabilities: readonly AgentCapability[];
  selectedAgent: AgentId;
  onUpdateGuidedBuild: (build: GuidedBuild) => void;
  onRunGuidedBuild: (prompt: string, build: GuidedBuild, mode: BuildMode, userMessage?: string, override?: GuidedRunOverride) => void | Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
  /** The open project, so a review can run its check and read the real diff. */
  projectId: string | null;
  /** The saved model choices; a target picked without a model is shown (and sent) with the one saved here. */
  modelSettings?: Pick<import('@kai/contracts').AppSettings, 'directApi' | 'savedLocalModels'>;
}): ReactNode {
  const {
    view, explaining, busy, error, onExplain, stripHidden, onToggleStrip, guidedBuild, conversation,
    agentCapabilities, selectedAgent, onUpdateGuidedBuild, onRunGuidedBuild, onOpenFile, projectId, modelSettings,
  } = props;
  const fallbackTarget = useMemo<RoleTarget>(() => ({ execution: 'cli', agent: selectedAgent }), [selectedAgent]);
  const [build, setBuild] = useState<GuidedBuild>(() => guidedBuild ?? emptyBuild(selectedAgent));
  const [message, setMessage] = useState('');
  const [credentialIds, setCredentialIds] = useState<readonly string[]>([]);
  const [providerModels, setProviderModels] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [working, setWorking] = useState<BuildMode | null>(null);
  const [planStart, setPlanStart] = useState<number | null>(null);
  const [reviewStart, setReviewStart] = useState<number | null>(null);
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const liveGatewayModels = useDirectApiModels(modelSettings);
  /** The check KAI ran for the review in flight, so a failing run can overrule a "ready" from the Coach. */
  const checkRef = useRef<CheckEvidence | null>(null);
  const step = build.steps[build.currentStep];
  const coach = build.coachTarget ?? fallbackTarget;
  // The saved Builder, else the saved Model team's, else the person's own gateway or local model, else the agent in use.
  const startingBuilder = modelSettings ? startingTargets(modelSettings).builder : null;
  const builder = build.builderTarget ?? startingBuilder ?? fallbackTarget;

  useEffect(() => {
    if (guidedBuild) setBuild(guidedBuild);
  }, [guidedBuild]);

  useEffect(() => {
    let alive = true;
    void window.kaiDesktop.credentialStatus().then(unwrap).then((status) => { if (alive) setCredentialIds(status.ids); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    for (const target of [coach, builder]) {
      if (target.execution !== 'api' || !target.api) continue;
      const api = target.api;
      const preset = directProviderPreset(api.provider);
      const key = `${api.provider}:${api.credentialId ?? preset.credentialId}`;
      if (providerModels.has(key)) continue;
      void window.kaiDesktop.listProviderModels({
        provider: api.provider,
        baseUrl: api.baseUrl ?? preset.defaultBaseUrl,
        credentialId: api.credentialId ?? preset.credentialId,
      }).then(unwrap).then((catalog) => {
        if (alive) setProviderModels((current) => new Map(current).set(key, catalog.models));
      }).catch(() => {
        if (alive) setProviderModels((current) => new Map(current).set(key, []));
      });
    }
    return () => { alive = false; };
  }, [coach, builder, providerModels]);

  useEffect(() => {
    if (!conversation || planStart === null || conversation.turns.length <= planStart) return;
    const answer = [...conversation.turns.slice(planStart)].reverse().find((turn) => turn.role === 'assistant');
    if (!answer) return;
    const plan = readGuidedPlan(answer.text, (index) => `guided-step-${index + 1}`);
    if (plan && plan.steps.length) {
      // Progress is kept when the plan is updated: finished steps stay finished and the place is kept.
      const merged = mergePlanProgress(plan.steps, build.steps);
      update({ ...build, enabled: true, planTitle: plan.title, steps: merged.steps, currentStep: merged.currentStep, review: null });
    }
    setPlanStart(null);
    setWorking(null);
  }, [conversation?.turns.length, planStart]);

  useEffect(() => {
    if (!conversation || reviewStart === null || conversation.turns.length <= reviewStart) return;
    const answer = [...conversation.turns.slice(reviewStart)].reverse().find((turn) => turn.role === 'assistant');
    if (!answer) return;
    const review = readGuidedReview(answer.text);
    if (review) {
      const gated = gateReview(review, checkRef.current);
      update({ ...build, steps: build.steps.map((item, index) => (index === build.currentStep && gated.status === 'ready' ? { ...item, status: 'complete' as const } : item)), review: { status: gated.status, summary: gated.summary, checkedAt: new Date().toISOString() } });
    }
    setReviewStart(null);
    setWorking(null);
  }, [conversation?.turns.length, reviewStart]);

  const update = (next: GuidedBuild): void => {
    setBuild(next);
    onUpdateGuidedBuild(next);
  };
  const options = (role: 'coach' | 'builder', target: RoleTarget) => targetOptions(role === 'coach' ? 'architect' : 'implementer', {
    capabilities: agentCapabilities,
    credentialIds,
    current: [coach, builder],
  });
  const modelOptions = (role: 'coach' | 'builder', target: RoleTarget) => {
    const key = target.execution === 'api' && target.api
      ? `${target.api.provider}:${target.api.credentialId ?? directProviderPreset(target.api.provider).credentialId}`
      : '';
    return roleModelOptions(role === 'coach' ? 'architect' : 'implementer', target, providerModels.get(key));
  };
  const chooseTarget = (role: 'coach' | 'builder', value: string): void => {
    const previous = role === 'coach' ? coach : builder;
    const target = targetFromValue(value, previous);
    if (!target) return;
    update(role === 'coach'
      ? { ...build, coachTarget: target, coachAgent: target.agent ?? build.coachAgent, coachModel: '' }
      : { ...build, builderTarget: target, builderAgent: target.agent ?? build.builderAgent, builderModel: '' });
  };
  const chooseModel = (role: 'coach' | 'builder', target: RoleTarget, value: string): void => {
    if (value === CUSTOM_ROLE_MODEL) {
      void promptDialog({ title: `Choose ${role} model`, label: 'Model name', initialValue: target.execution === 'api' ? target.api?.model ?? '' : target.model ?? '', placeholder: 'Model name', confirmLabel: 'Use model' })
        .then((model) => { if (model?.trim()) chooseModel(role, target, model.trim()); });
      return;
    }
    const next = withModel(target, value);
    update(role === 'coach' ? { ...build, coachTarget: next, coachModel: value } : { ...build, builderTarget: next, builderModel: value });
  };

  const run = async (mode: BuildMode, prompt: string, override?: GuidedRunOverride, label?: string): Promise<void> => {
    if (!prompt.trim() || working) return;
    setWorking(mode);
    const turnCount = conversation?.turns.length ?? 0;
    if (mode === 'plan') setPlanStart(turnCount);
    if (mode === 'review') setReviewStart(turnCount);
    const userMessage = mode === 'review' ? 'Check my edit' : label ?? (message.trim() || step?.title || 'Continue Guided Build');
    try { await onRunGuidedBuild(prompt, build, mode, userMessage, override); }
    catch { setWorking(null); setPlanStart(null); setReviewStart(null); }
    setMessage('');
  };

  const planPrompt = (idea: string, addToPlan: boolean): string => addToPlan
    ? addIdeaPrompt(idea, build.planTitle, build.steps, build.style, build.detail, build.questions)
    : buildPlanPrompt(idea, build.style, build.detail, build.questions);
  const askCoach = (): void => {
    const question = message.trim();
    if (!question) return;
    if (!build.steps.length) void run('plan', planPrompt(question, false));
    else {
      void run('coach', coachPrompt(question, build.style, build.detail, build.questions, step));
    }
  };
  // The idea comes from the card's own box, or from the message box when the button beside it is used.
  const addIdea = (typed?: string): void => {
    const idea = (typed ?? message).trim();
    if (!idea) return;
    void run('plan', planPrompt(idea, true), undefined, idea);
  };
  const sendToBuilder = (mode: 'show-code' | 'write-code'): void => {
    const request = message.trim() || step?.instructions || step?.title || '';
    if (!request) return;
    const prompt = mode === 'show-code' ? showCodePrompt(step, request) : writeCodePrompt(step, request);
    void run(mode, prompt);
  };
  const askForReview = (): void => {
    if (!step || working) return;
    const latest = [...(conversation?.events ?? [])].reverse().find((event) => event.type === 'turn.changes');
    const reported = latest && 'files' in latest ? latest.files.map((file) => file.path) : [];
    setWorking('review');
    void (async () => {
      const { check, notRun } = await collectCheck(projectId);
      const files = await collectDiffs(projectId, step.where, reported);
      checkRef.current = check;
      const evidence = diffText(files) + '\n\n' + evidenceText(check, notRun);
      setWorking(null);
      await run('review', reviewPrompt(step, files.map((file) => file.path), evidence));
    })().catch(() => setWorking(null));
  };
  /** Builds the current step with the saved Builder, or with a model picked for this one step only. */
  const buildStep = (picked: RoleTarget, justThisStep = false): void => {
    if (!step) return;
    // A provider picked from the menu has no model of its own; the run uses the one saved in Settings, so say which.
    const target = modelSettings ? withSettingsModel(picked, modelSettings) : picked;
    const role = describeRole(target, agentNames);
    void run('write-code', role.local ? localBuilderStepPrompt(step) : builderStepPrompt(step), justThisStep ? { target, local: role.local } : undefined);
  };
  const learn = (kind: LearnAction): void => {
    void run('coach', learnPrompt(kind, step, build.style, build.detail));
  };
  const generatePlan = (): void => {
    if (message.trim()) { askCoach(); return; }
    if (build.brief) void run('plan', planFromBriefPrompt(build.brief, build.style, build.detail, build.questions));
  };

  // Learn & Code shares a project with ordinary Workspace runs. Only render exchanges that were
  // explicitly sent through Guided Build; this prevents unrelated Builder output appearing here.
  const allTurns = conversation?.turns ?? [];
  const guidedIndexes = guidedTurnIndexes(allTurns);
  const guidedEntries = [...guidedIndexes].map((index) => ({ turn: allTurns[index]!, index }));
  const chatTurns = guidedEntries.slice(-16);
  const lastAssistant = [...chatTurns].reverse().find(({ turn }) => turn.role === 'assistant' && !isStructuredResponse(turn.text))?.turn;
  const roleLabelFor = (index: number): string => {
    const current = chatTurns[index];
    if (!current || current.turn.role === 'user') return 'You';
    const previousUser = [...chatTurns.slice(0, index)].reverse().find((entry) => entry.turn.role === 'user')?.turn.text.toLowerCase() ?? '';
    return previousUser.includes('builder') || previousUser.includes('write this change') ? 'Builder' : 'Coach';
  };
  const currentSpeaker = working === 'plan' || working === 'coach' || working === 'review' ? 'Coach' : working ? 'Builder' : '';
  const agentNames = Object.fromEntries(agentCapabilities.map((agent) => [agent.id, agent.displayName]));
  // Every model one step could be built with, by name, for the With menu.
  const stepChoices = modelSettings ? stepModelChoices({ settings: modelSettings, agents: agentCapabilities, liveModels: liveGatewayModels, coach, agentNames }) : [];
  const coachRole = describeRole(modelSettings ? withSettingsModel(coach, modelSettings) : coach, agentNames);
  const builderRole = describeRole(modelSettings ? withSettingsModel(builder, modelSettings) : builder, agentNames);
  const lastTurn = allTurns.at(-1);
  const lastAsked = [...allTurns].reverse().find((turn) => turn.role === 'user')?.text ?? '';
  const builderStuck = lastTurn?.role === 'assistant' && lastAsked.startsWith('Builder: implement') ? builderStuckReason(lastTurn.text) : null;
  const settingsOptions = [
    { value: 'tutor', label: 'Tutor' }, { value: 'senior-dev', label: 'Senior Dev' },
  ];
  return (
    <div className="guided-build-learn-panel" aria-label="Guided Build">
      <header className="guided-build-learn-header">
        <div><h2><Sparkles size={16} /> Guided Build</h2><p>Coach makes a plan and walks you through each change. You choose when Builder writes to files.</p></div>
        <UiButton type="button" className="link-button" onClick={onToggleStrip}>{stripHidden ? 'Show guide above the editor' : 'Hide guide above the editor'}</UiButton>
      </header>
      {error && <p className="studio-note error" role="alert">{error}</p>}
      <GuidedBuildCard
        state={build}
        disabled={Boolean(working)}
        planBusy={working === 'plan'}
        reviewBusy={working === 'review'}
        coachLabel={coachRole.label}
        builderLabel={builderRole.label}
        builderIsLocal={builderRole.local}
        hasBrief={Boolean(build.brief)}
        stuckReason={builderStuck}
        escalateLabel={builderRole.local && build.builderLock !== 'pinned' ? coachRole.label : null}
        onEscalate={() => { if (step) void run('write-code', builderStepPrompt(step), { target: coach, local: false }); }}
        handsOn={build.handsOn}
        withOptions={stepChoices.map(({ value, label }) => ({ value, label }))}
        onBuildWith={(value) => { const choice = stepChoices.find((item) => item.value === value); if (choice) buildStep(choice.target, true); }}
        onChange={update}
        onOpenFile={onOpenFile}
        onGeneratePlan={generatePlan}
        onAddIdea={addIdea}
        onBuild={() => buildStep(builder)}
        onShowCode={() => sendToBuilder('show-code')}
        onReview={askForReview}
        onOpenTeam={() => setTeamOpen(true)}
        onNext={() => update({ ...build, currentStep: Math.min(build.steps.length - 1, build.currentStep + 1), review: null })}
      />
      {teamOpen && (
        <GuidedBuildTeamPanel
          state={build}
          disabled={Boolean(working)}
          projectId={projectId}
          coachLabel={coachRole.label}
          builderLabel={builderRole.label}
          builderIsLocal={builderRole.local}
          builderTarget={builder}
          coachTarget={coach}
          usage={guidedUsage(allTurns)}
          onChange={update}
          onClose={() => setTeamOpen(false)}
          rolePickers={<div className="flex flex-wrap items-center gap-2">
            <OptionMenu ariaLabel="Coach agent" icon={<Sparkles size={12} />} onChange={(value) => chooseTarget('coach', value)} options={options('coach', coach)} title="Choose the Coach that makes plans and answers your questions" value={targetValue(coach)} />
            <OptionMenu ariaLabel="Coach model" onChange={(value) => chooseModel('coach', coach, value)} options={modelOptions('coach', coach)} title="Choose Coach model" value={coach.execution === 'api' ? coach.api?.model ?? '' : coach.model ?? ''} />
            <OptionMenu ariaLabel="Builder agent" icon={<Cpu size={12} />} onChange={(value) => chooseTarget('builder', value)} options={options('builder', builder)} title="Choose the Builder that provides code or edits files" value={targetValue(builder)} />
            <OptionMenu ariaLabel="Builder model" onChange={(value) => chooseModel('builder', builder, value)} options={modelOptions('builder', builder)} title="Choose Builder model" value={builder.execution === 'api' ? builder.api?.model ?? '' : builder.model ?? ''} />
          </div>}
        />
      )}
      {step && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2" aria-label="Learn from this step">
          <span className="text-xs text-[var(--text-dim)]">Learn:</span>
          <UiButton type="button" className="secondary-button" disabled={Boolean(working)} onClick={() => learn('walk')}>Walk me through it</UiButton>
          <UiButton type="button" className="secondary-button" disabled={Boolean(working)} onClick={() => learn('quiz')}>Quiz me</UiButton>
          <UiButton type="button" className="secondary-button" disabled={Boolean(working)} onClick={() => learn('simpler')}>Explain simpler</UiButton>
        </div>
      )}

      {chatTurns.length > 0 && <div className="guided-build-chat" aria-label="Guided Build conversation">{chatTurns.map(({ turn }, index) => {
        const visibleText = turn.role === 'assistant' ? visibleGuidedBuildReply(turn.text) : turn.text;
        return visibleText ? <article className={`guided-build-chat-turn ${turn.role}`} key={turn.id}><strong>{turn.role === 'user' ? 'You' : roleLabelFor(index)}</strong><Markdown text={visibleText} /></article> : null;
      })}</div>}
      {working && <div className="guided-build-working" role="status"><Loader2 size={14} className="spin" /> {currentSpeaker} is {working === 'plan' ? 'planning your steps' : working === 'review' ? 'checking your edit' : working === 'show-code' ? 'preparing code for you to type' : working === 'write-code' ? 'editing the file' : 'answering you'}.</div>}

      <Composer className="guided-build-mini-composer">
        <ComposerInput aria-label="Message the Coach or Builder" placeholder={step ? 'Ask Coach a question or tell Builder what to change…' : 'Describe your idea for Coach…'} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); askCoach(); } }} />
        <ComposerToolbar
          leading={<>
            <UiButton type="button" className="link-button" aria-expanded={composerSettingsOpen} onClick={() => setComposerSettingsOpen((open) => !open)}>Composer settings</UiButton>
            {composerSettingsOpen && <>
              <OptionMenu ariaLabel="Coach agent" icon={<Sparkles size={12} />} onChange={(value) => chooseTarget('coach', value)} options={options('coach', coach)} title="Choose the Coach that makes plans and answers your questions" value={targetValue(coach)} />
              <OptionMenu ariaLabel="Coach model" onChange={(value) => chooseModel('coach', coach, value)} options={modelOptions('coach', coach)} title="Choose Coach model" value={coach.execution === 'api' ? coach.api?.model ?? '' : coach.model ?? ''} />
              <OptionMenu ariaLabel="Builder agent" icon={<Cpu size={12} />} onChange={(value) => chooseTarget('builder', value)} options={options('builder', builder)} title="Choose the Builder that provides code or edits files" value={targetValue(builder)} />
              <OptionMenu ariaLabel="Builder model" onChange={(value) => chooseModel('builder', builder, value)} options={modelOptions('builder', builder)} title="Choose Builder model" value={builder.execution === 'api' ? builder.api?.model ?? '' : builder.model ?? ''} />
              <OptionMenu ariaLabel="Coach style" onChange={(value) => update({ ...build, style: value as GuidedBuild['style'] })} options={settingsOptions} title="Choose how Coach explains the steps" value={build.style} />
              <OptionMenu ariaLabel="Explanation detail" onChange={(value) => update({ ...build, detail: value as GuidedBuild['detail'] })} options={[{ value: 'brief', label: 'Brief' }, { value: 'step-by-step', label: 'Step by step' }, { value: 'line-by-line', label: 'Line by line' }]} title="Choose how much detail Coach gives" value={build.detail} />
              <OptionMenu ariaLabel="How hands-on" onChange={(value) => update({ ...build, handsOn: value as GuidedBuild['handsOn'] })} options={[{ value: 'auto', label: 'Do it for me' }, { value: 'guided', label: 'Walk me through it' }, { value: 'manual', label: "I'll type, you check" }]} title="Choose how much you want to do yourself" value={build.handsOn} />
              <OptionMenu ariaLabel="If the Builder is stuck" onChange={(value) => update({ ...build, builderLock: value as GuidedBuild['builderLock'] })} options={[{ value: 'escalate', label: 'Offer a stronger model' }, { value: 'pinned', label: 'Always this model' }]} title="What to do when the Builder cannot finish a step" value={build.builderLock} />
              <OptionMenu ariaLabel="When Coach asks you questions" onChange={(value) => update({ ...build, questions: value as GuidedBuild['questions'] })} options={[{ value: 'blocked', label: 'Only when blocked' }, { value: 'decisions', label: 'Before big choices' }, { value: 'each-step', label: 'At each step' }]} title="Choose when Coach asks you for clarification" value={build.questions} />
            </>}
          </>}
          actions={<>
            {build.steps.length > 0 && <UiButton type="button" className="secondary-button" disabled={!message.trim() || Boolean(working)} onClick={() => addIdea()}>Add idea to plan</UiButton>}
            {build.steps.length > 0 && <UiButton type="button" className="secondary-button" disabled={(!message.trim() && !step) || Boolean(working)} onClick={() => sendToBuilder('show-code')}>Show me code</UiButton>}
            {build.steps.length > 0 && <UiButton type="button" className="primary-button" disabled={(!message.trim() && !step) || Boolean(working)} onClick={() => sendToBuilder('write-code')}>Builder, edit the file</UiButton>}
            <ComposerSend label={build.steps.length ? 'Ask Coach' : 'Create plan with Coach'} title={build.steps.length ? 'Ask Coach a question' : 'Turn your idea into a step-by-step plan'} disabled={!message.trim() || Boolean(working)} onClick={askCoach} />
          </>}
        />
      </Composer>
      <details className="guided-build-project-context"><summary>Project progress</summary>
        {!view ? <p>{explaining ? 'Reading the project…' : 'Project summary is not available yet.'}</p> : <>
          <p>{view.narrative?.explanation ?? view.narrative?.headline ?? 'No project summary yet.'}</p>
          {!explaining && <UiButton type="button" className="link-button" onClick={onExplain} disabled={busy}>{view.narrative ? 'Update project summary' : 'Read project progress'}</UiButton>}
          {view.steps.length > 0 && <ol className="guide-steps">{view.steps.map((item) => <li key={item.id}><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}{item.action && item.actionLabel && <UiButton type="button" className="secondary-button" disabled={busy} onClick={() => props.onAction(item.action as CodeGuideAction)}>{item.actionLabel}</UiButton>}</li>)}</ol>}
        </>}
      </details>
      {lastAssistant && <span className="sr-only" aria-live="polite">Latest reply from {roleLabelFor(chatTurns.length - 1)}.</span>}
    </div>
  );
}

function emptyBuild(agent: AgentId): GuidedBuild {
  return { enabled: true, coachTarget: null, builderTarget: null, coachAgent: agent, coachModel: '', builderAgent: agent, builderModel: '', style: 'tutor', detail: 'step-by-step', questions: 'blocked', followEdits: true, handsOn: 'guided', builderLock: 'escalate', planTitle: '', steps: [], currentStep: 0, review: null };
}

function parseObject(text: string): Record<string, unknown> | null {
  return parseGuidedBuildObject(text);
}

function isStructuredResponse(text: string): boolean {
  const data = parseObject(text);
  return Boolean(data && ((typeof data.title === 'string' && Array.isArray(data.steps)) || (typeof data.summary === 'string' && typeof data.status === 'string')));
}
