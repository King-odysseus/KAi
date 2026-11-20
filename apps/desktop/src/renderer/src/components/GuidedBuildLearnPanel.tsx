import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Cpu, Loader2, MessageCircle, Sparkles } from 'lucide-react';
import type { AgentCapability, AgentId, CodeGuideAction, CodeGuideView, ConversationRecord, GuidedBuild, GuidedBuildStep, RoleTarget } from '@kai/contracts';
import { directProviderPreset } from '@kai/contracts';
import { Composer, ComposerInput, ComposerSend, ComposerToolbar } from './ui/Composer';
import { OptionMenu } from './ui/OptionMenu';
import { UiButton } from './UiButton';
import { CUSTOM_ROLE_MODEL, roleModelOptions, targetFromValue, targetOptions, targetValue, withModel } from './architect-settings';
import { promptDialog } from './AppDialog';
import { Markdown } from './Markdown';
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
  onRunGuidedBuild: (prompt: string, build: GuidedBuild, mode: BuildMode) => void | Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
}): ReactNode {
  const {
    view, explaining, busy, error, onExplain, stripHidden, onToggleStrip, guidedBuild, conversation,
    agentCapabilities, selectedAgent, onUpdateGuidedBuild, onRunGuidedBuild, onOpenFile,
  } = props;
  const fallbackTarget = useMemo<RoleTarget>(() => ({ execution: 'cli', agent: selectedAgent }), [selectedAgent]);
  const [build, setBuild] = useState<GuidedBuild>(() => guidedBuild ?? emptyBuild(selectedAgent, fallbackTarget));
  const [message, setMessage] = useState('');
  const [credentialIds, setCredentialIds] = useState<readonly string[]>([]);
  const [providerModels, setProviderModels] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [working, setWorking] = useState<BuildMode | null>(null);
  const [planStart, setPlanStart] = useState<number | null>(null);
  const [reviewStart, setReviewStart] = useState<number | null>(null);
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false);
  const step = build.steps[build.currentStep];
  const coach = build.coachTarget ?? fallbackTarget;
  const builder = build.builderTarget ?? fallbackTarget;

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
    const answer = [...conversation.turns].reverse().find((turn) => turn.role === 'assistant');
    if (!answer) return;
    const data = parseObject(answer.text);
    if (data && typeof data.title === 'string' && Array.isArray(data.steps)) {
      const steps: GuidedBuildStep[] = data.steps.flatMap((raw, index) => {
        if (!raw || typeof raw !== 'object') return [];
        const item = raw as Record<string, unknown>;
        if (typeof item.title !== 'string') return [];
        return [{
          id: typeof item.id === 'string' ? item.id : `guided-step-${index + 1}`,
          title: item.title,
          why: typeof item.why === 'string' ? item.why : '',
          where: typeof item.where === 'string' ? item.where : '',
          instructions: typeof item.instructions === 'string' ? item.instructions : '',
          ...(typeof item.code === 'string' ? { code: item.code } : {}),
          acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.filter((entry): entry is string => typeof entry === 'string') : [],
          status: index === 0 ? 'active' : 'pending',
        }];
      });
      if (steps.length) update({ ...build, enabled: true, planTitle: data.title, steps, currentStep: 0, review: null });
    }
    setPlanStart(null);
    setWorking(null);
  }, [conversation?.turns.length, planStart]);

  useEffect(() => {
    if (!conversation || reviewStart === null || conversation.turns.length <= reviewStart) return;
    const answer = [...conversation.turns].reverse().find((turn) => turn.role === 'assistant');
    if (!answer) return;
    const data = parseObject(answer.text);
    if (data && ['ready', 'changes-needed', 'unverified'].includes(String(data.status)) && typeof data.summary === 'string') {
      update({ ...build, review: { status: data.status as 'ready' | 'changes-needed' | 'unverified', summary: data.summary, checkedAt: new Date().toISOString() } });
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

  const run = async (mode: BuildMode, prompt: string): Promise<void> => {
    if (!prompt.trim() || working) return;
    setWorking(mode);
    const turnCount = conversation?.turns.length ?? 0;
    if (mode === 'plan') setPlanStart(turnCount);
    if (mode === 'review') setReviewStart(turnCount);
    if (mode === 'review') setReviewStart(turnCount);
    try { await onRunGuidedBuild(prompt, build, mode); }
    catch { setWorking(null); setPlanStart(null); setReviewStart(null); }
    setMessage('');
  };

  const planPrompt = (idea: string, addToPlan: boolean): string => {
    const existing = build.steps.map((item, index) => `${index + 1}. ${item.title}: ${item.instructions}`).join('\n');
    const questionRule = build.questions === 'blocked' ? 'Ask me only if you cannot safely continue.' : build.questions === 'decisions' ? 'Ask me before a major decision.' : 'Ask me once before each new step.';
    const teachingStyle = `Explain in a ${build.style === 'senior-dev' ? 'senior developer' : 'tutor'} style with ${build.detail} detail.`;
    return addToPlan
      ? `Fit this new idea into my current coding plan. Add, combine, or reorder steps as needed, and keep the other useful steps. Current plan: ${build.planTitle}\n${existing}\nNew idea: ${idea}\nFor each step explain why it matters, name the exact file and place to edit, give clear instructions, and say how to check it. ${teachingStyle} ${questionRule} Return only JSON with title and steps; each step needs title, why, where, instructions, optional code, and acceptanceCriteria.`
      : `Make a step-by-step coding plan for my idea: ${idea}\nFor each step explain why it matters, name the exact file and place to edit, give clear instructions, and say how to check it. ${teachingStyle} ${questionRule} Return only JSON with title and steps; each step needs title, why, where, instructions, optional code, and acceptanceCriteria.`;
  };
  const askCoach = (): void => {
    const question = message.trim();
    if (!question) return;
    if (!build.steps.length) void run('plan', planPrompt(question, false));
    else void run('coach', `Answer this question about my project and current coding plan. Be clear and beginner-friendly. Do not ask me a question back; if information is missing, say what you assumed. My question: ${question}\nCurrent step: ${step?.title ?? 'none'}.`);
  };
  const addIdea = (): void => {
    const idea = message.trim();
    if (!idea) return;
    void run('plan', planPrompt(idea, true));
  };
  const sendToBuilder = (mode: 'show-code' | 'write-code'): void => {
    const request = message.trim() || step?.instructions || step?.title || '';
    if (!request) return;
    const stepContext = step ? `Current plan step: ${step.title}. Why: ${step.why}. Instructions: ${step.instructions}. Check it by: ${step.acceptanceCriteria.join('; ')}.` : '';
    const file = step?.where ? `Open this file: ${step.where}.` : 'Find the right file and tell me which one you chose.';
    const prompt = mode === 'show-code'
      ? `Help me make this change myself: ${request}\n${stepContext}\n${file}\nDo not edit files. Show me exactly where to type and the exact code to enter, then explain briefly what it does. Do not ask me questions.`
      : `Make this change in the project: ${request}\n${stepContext}\n${file}\nEdit the file for me. Do not ask me questions; make a sensible assumption if needed.`;
    void run(mode, prompt);
  };
  const askForReview = (): void => {
    if (!step) return;
    const prompt = `Check whether my saved code meets this step. Step: ${step.title}. Instructions: ${step.instructions}. File: ${step.where}. Checks: ${step.acceptanceCriteria.join('; ')}. Do not edit files or ask questions. Return only JSON with status ready, changes-needed, or unverified and a short summary.`;
    void run('review', prompt);
  };

  const lastAssistant = [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === 'assistant' && !isStructuredResponse(turn.text));
  const chatTurns = (conversation?.turns ?? []).slice(-8).filter((turn) => !isStructuredResponse(turn.text));
  const roleLabelFor = (index: number): string => {
    const previousUser = chatTurns.slice(0, index).reverse().find((turn) => turn.role === 'user')?.text.toLowerCase() ?? '';
    return previousUser.includes('coach') || previousUser.includes('plan') || previousUser.includes('question') ? 'Coach' : 'Builder';
  };
  const currentSpeaker = working === 'plan' || working === 'coach' || working === 'review' ? 'Coach' : working ? 'Builder' : '';
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
      {step ? <section className="guided-build-active-step" aria-label="Current coding step">
        <div className="guided-build-step-heading"><span>STEP {build.currentStep + 1} OF {build.steps.length}</span><h3>{step.title}</h3></div>
        {step.why && <p>{step.why}</p>}
        {step.where && <div className="guided-build-file-row"><code>{step.where}</code><UiButton type="button" className="secondary-button" onClick={() => onOpenFile(step.where.split(':')[0]!, Number(step.where.split(':')[1]) || undefined)}>Open file</UiButton></div>}
        {step.instructions && <div className="guided-build-instructions"><strong>What to do</strong><p>{step.instructions}</p></div>}
        {step.acceptanceCriteria.length > 0 && <div className="guided-build-instructions"><strong>How to check it</strong><ul>{step.acceptanceCriteria.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
        <div className="guided-build-step-footer"><span>{build.review?.summary ?? 'When you finish, ask Coach to check the saved file.'}</span><UiButton type="button" className="secondary-button" disabled={Boolean(working)} onClick={askForReview}>{working === 'review' ? 'Coach is checking…' : 'Ask Coach to check my edit'}</UiButton><UiButton type="button" className="secondary-button" disabled={!build.review || build.currentStep >= build.steps.length - 1} onClick={() => update({ ...build, currentStep: Math.min(build.steps.length - 1, build.currentStep + 1), review: null })}>Next step</UiButton></div>
      </section> : <section className="guided-build-empty"><h3>Start with your idea</h3><p>Tell Coach what you want to build. Coach will make the plan and choose the first file to open.</p></section>}

      {chatTurns.length > 0 && <div className="guided-build-chat" aria-label="Coach and Builder conversation">{chatTurns.map((turn, index) => <article className={`guided-build-chat-turn ${turn.role}`} key={turn.id}><strong>{turn.role === 'user' ? 'You' : roleLabelFor(index)}</strong><Markdown text={turn.text} /></article>)}</div>}
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
              <OptionMenu ariaLabel="When Coach asks you questions" onChange={(value) => update({ ...build, questions: value as GuidedBuild['questions'] })} options={[{ value: 'blocked', label: 'Only when blocked' }, { value: 'decisions', label: 'Before big choices' }, { value: 'each-step', label: 'At each step' }]} title="Choose when Coach asks you for clarification" value={build.questions} />
            </>}
          </>}
          actions={<>
            {build.steps.length > 0 && <UiButton type="button" className="secondary-button" disabled={!message.trim() || Boolean(working)} onClick={addIdea}>Add idea to plan</UiButton>}
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

function emptyBuild(agent: AgentId, target: RoleTarget): GuidedBuild {
  return { enabled: true, coachTarget: target, builderTarget: target, coachAgent: agent, coachModel: '', builderAgent: agent, builderModel: '', style: 'tutor', detail: 'step-by-step', questions: 'blocked', followEdits: true, planTitle: '', steps: [], currentStep: 0, review: null };
}

function parseObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

function isStructuredResponse(text: string): boolean {
  const data = parseObject(text);
  return Boolean(data && ((typeof data.title === 'string' && Array.isArray(data.steps)) || (typeof data.summary === 'string' && typeof data.status === 'string')));
}
