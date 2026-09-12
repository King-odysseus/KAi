/* KAI Agent Workbench — Chat UI Script */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var AGENT_IDS = window.__KAI_AGENT_IDS__ || ['claude', 'codex', 'qwen', 'gemini'];
  var AGENT_NAMES = window.__KAI_AGENT_NAMES__ || {};
  var AGENT_MODELS = window.__KAI_AGENT_MODELS__ || {};
  var CONTEXT_WINDOWS = window.__KAI_CONTEXT_WINDOWS__ || {};
  var PERMISSION_KEYS = window.__KAI_PERMISSION_KEYS__ || {};
  var customPermissions = window.__KAI_CUSTOM_PERMISSIONS__ || {};
  var state = window.__KAI_INITIAL_STATE__ || null;
  var currentGoal = window.__KAI_INITIAL_GOAL__ || null;
  var skills = [];
  var selectedSkills = [];
  function currentAgent() { return state ? state.activeAgent : 'claude'; }
  function currentRoute() { return state ? state.route : 'direct'; }
  function currentAutonomy() { return state ? state.autonomy : 'ask'; }
  var totalCost = 0;
  var totalInput = 0;
  var totalOutput = 0;
  var currentAssistant = null;
  var planMode = false;
  var planSteps = [];
  var currentPlan = window.__KAI_INITIAL_PLAN__ || null;
  var activeCompare = null;

  // Reply "turns" — one per taskId, holding the agent header, grouped tool
  // calls, streamed markdown text and message actions. See ensureTurn().
  var turns = {};
  var pendingTurnMeta = {};
  var capabilitiesById = {};
  var lastUserPrompt = '';

  var TPLS = {
    review: 'Review this code for bugs, style issues, and improvements:',
    implement: 'Implement the following change:',
    debug: 'Debug this issue:',
    explain: 'Explain how this code works:',
    test: 'Write tests for:',
  };

  var MODES = [
    { id: 'plan', label: 'Plan', desc: 'Read-only. Looks around and proposes a plan before editing.' },
    { id: 'ask', label: 'Ask before edits', desc: 'Asks before each file edit and command.' },
    { id: 'autoEdit', label: 'Edit automatically', desc: 'Edits files without asking. Still asks before risky commands.' },
    { id: 'full', label: 'Full access', desc: 'Never asks. Best inside a worktree or a sandbox.', warn: true },
    { id: 'custom', label: 'Custom…', desc: 'Choose which actions need approval.' },
  ];
  function modeLabel(id) { var m = MODES.filter(function (x) { return x.id === id; })[0]; return m ? m.label : id; }

  var els = {
    prompt: document.getElementById('prompt'),
    send: document.getElementById('send'),
    statePill: document.getElementById('statePill'),
    costPill: document.getElementById('costPill'),
    chat: document.getElementById('chat'),
    costEstimate: document.getElementById('costEstimate'),
    planToggle: document.getElementById('planToggle'),
    planEditor: document.getElementById('planEditor'),
    planTitle: document.getElementById('planTitle'),
    planSteps: document.getElementById('planSteps'),
    addStep: document.getElementById('addStep'),
    runPlan: document.getElementById('runPlan'),
    planProgress: document.getElementById('planProgress'),
    planStepCount: document.getElementById('planStepCount'),
    planTemplate: document.getElementById('planTemplate'),
    saveTemplateBtn: document.getElementById('saveTemplateBtn'),
    goalEditor: document.getElementById('goalEditor'),
    goalProgress: document.getElementById('goalProgress'),
    goalOutcome: document.getElementById('goalOutcome'),
    goalConstraints: document.getElementById('goalConstraints'),
    goalVerification: document.getElementById('goalVerification'),
    goalCancel: document.getElementById('goalCancel'),
    goalSave: document.getElementById('goalSave'),
    goalStart: document.getElementById('goalStart'),
    goalBtn: document.getElementById('goalBtn'),
    skillsBtn: document.getElementById('skillsBtn'),
    skillsPanel: document.getElementById('skillsPanel'),
    skillsSearch: document.getElementById('skillsSearch'),
    skillsClose: document.getElementById('skillsClose'),
    skillsList: document.getElementById('skillsList'),
    composerBox: document.getElementById('composerBox'),
    modeChip: document.getElementById('modeChip'),
    agentChip: document.getElementById('agentChip'),
    ctxMeter: document.getElementById('ctxMeter'),
    ctxChipRow: document.getElementById('ctxChipRow'),
    queueList: document.getElementById('queueList'),
    attachBtn: document.getElementById('attachBtn'),
    imageFileInput: document.getElementById('imageFileInput'),
    atBtn: document.getElementById('atBtn'),
    sessionMeta: document.getElementById('sessionMeta'),
    historyPanel: document.getElementById('historyPanel'),
    historySearch: document.getElementById('historySearch'),
    historyClose: document.getElementById('historyClose'),
    historyList: document.getElementById('historyList'),
    compareToggle: document.getElementById('compareToggle'),
    compareAgentB: document.getElementById('compareAgentB'),
  };

  var emptyState = document.getElementById('emptyState');

  var STATUS_WORDS = ['Thinking','Channelling','Pondering','Reasoning','Cogitating','Percolating','Scheming','Conjuring','Synthesizing','Noodling','Ruminating','Untangling','Deliberating','Formulating','Brewing','Contemplating','Wrangling','Computing','Divining','Mulling'];
  var thinkingEl = null, thinkingWordTimer = null, thinkingClockTimer = null, thinkingStart = 0, thinkingWordIdx = 0, thinkingDetail = '';

  function fmtElapsed(ms) { var s = Math.floor(ms/1000); if(s<60) return s+'s'; var m = Math.floor(s/60); return m+'m '+(s%60)+'s'; }
  function pickStatusWord() { thinkingWordIdx = (thinkingWordIdx+1+Math.floor(Math.random()*3))%STATUS_WORDS.length; return STATUS_WORDS[thinkingWordIdx]; }

  function startThinking() {
    if(thinkingEl) return; removeEmpty();
    thinkingEl = document.createElement('div'); thinkingEl.className = 'thinking';
    thinkingWordIdx = Math.floor(Math.random()*STATUS_WORDS.length);
    thinkingEl.innerHTML = '<span class="spinner"></span><span class="status-word">'+esc(STATUS_WORDS[thinkingWordIdx])+'</span><span class="status-detail"></span><span class="status-timer">0s</span>';
    els.chat.appendChild(thinkingEl); thinkingStart = Date.now(); thinkingDetail = ''; scrollBottom(true);
    thinkingWordTimer = setInterval(function(){ if(!thinkingEl) return; var w=thinkingEl.querySelector('.status-word'); if(w) w.textContent=pickStatusWord(); },2600);
    thinkingClockTimer = setInterval(function(){ if(!thinkingEl) return; var t=thinkingEl.querySelector('.status-timer'); if(t) t.textContent=fmtElapsed(Date.now()-thinkingStart); },1000);
  }
  function setThinkingDetail(text) { thinkingDetail=text||''; if(thinkingEl){ var d=thinkingEl.querySelector('.status-detail'); if(d) d.textContent=thinkingDetail; } }
  function stopThinking() { if(thinkingWordTimer){clearInterval(thinkingWordTimer);thinkingWordTimer=null;} if(thinkingClockTimer){clearInterval(thinkingClockTimer);thinkingClockTimer=null;} if(thinkingEl){thinkingEl.remove();thinkingEl=null;} }

  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtTime(iso) { try{return new Date(iso).toLocaleTimeString();}catch(e){return '';} }
  function nearBottom() { return els.chat.scrollHeight-els.chat.scrollTop-els.chat.clientHeight<120; }
  function scrollBottom(force) { if(force||nearBottom()) els.chat.scrollTop=els.chat.scrollHeight; }
  function removeEmpty() { if(emptyState) emptyState.style.display='none'; }
  function clearChat() {
    finalizeAssistant(); stopThinking();
    Array.prototype.slice.call(els.chat.children).forEach(function(k){ if(k!==emptyState) k.remove(); });
    if(emptyState) emptyState.style.display='';
    totalCost=0;totalInput=0;totalOutput=0; els.costPill.innerHTML=''; els.sessionMeta.textContent='';
    lastKnownInputTokens = 0; renderContextMeter();
    for (var id in turns) { if (turns[id].timerInterval) clearInterval(turns[id].timerInterval); }
    turns = {};
    contextChips = []; selectedSkills = []; messageQueue = []; renderCtxChips(); renderQueue();
    clearPrompt();
  }
  function autoGrow() { els.prompt.style.height='auto'; els.prompt.style.height=Math.min(els.prompt.scrollHeight,180)+'px'; }
  function agentLabel(agent) { return AGENT_NAMES[agent] || (agent ? agent.charAt(0).toUpperCase()+agent.slice(1) : 'Assistant'); }

  // ---- History panel (past conversations) ----
  function openHistory() { closeSkillsPanel(); els.historyPanel.style.display = 'flex'; els.historySearch.value = ''; els.historySearch.focus(); vscode.postMessage({ type: 'listConversations' }); }
  function closeHistory() { els.historyPanel.style.display = 'none'; }

  function fmtRelativeTime(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function renderHistoryList(conversations) {
    els.historyList.innerHTML = '';
    if (!conversations || conversations.length === 0) {
      var empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'No conversations yet.';
      els.historyList.appendChild(empty);
      return;
    }
    conversations.forEach(function (meta) {
      var item = document.createElement('div'); item.className = 'history-item' + (meta.archived ? ' archived' : '');
      if (meta.unread) { var dot = document.createElement('span'); dot.className = 'unread-dot'; item.appendChild(dot); }

      var main = document.createElement('div'); main.className = 'history-main';
      var title = document.createElement('div'); title.className = 'history-title'; title.textContent = meta.title;
      var metaRow = document.createElement('div'); metaRow.className = 'history-meta';
      meta.agents.forEach(function (a) { var d = document.createElement('span'); d.className = 'agent-dot ' + a; metaRow.appendChild(d); });
      var metaText = document.createElement('span');
      metaText.textContent = (meta.costUsd > 0 ? '$' + meta.costUsd.toFixed(4) + ' · ' : '') + fmtRelativeTime(meta.updatedAt);
      metaRow.appendChild(metaText);
      main.appendChild(title); main.appendChild(metaRow);
      item.appendChild(main);

      var actions = document.createElement('div'); actions.className = 'history-actions';
      function actionBtn(title_, svg, onClick) {
        var b = document.createElement('span'); b.className = 'ibtn small'; b.title = title_; b.innerHTML = svg;
        b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
        actions.appendChild(b);
      }
      actionBtn('Rename', '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>', function () {
        var name = prompt('Rename conversation:', meta.title);
        if (name && name.trim()) vscode.postMessage({ type: 'renameConversation', conversationId: meta.id, value: name.trim() });
      });
      actionBtn('Fork', '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10a6 6 0 0 1-6 6H8"/></svg>', function () {
        vscode.postMessage({ type: 'forkConversation', conversationId: meta.id });
      });
      actionBtn(meta.archived ? 'Unarchive' : 'Archive', '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>', function () {
        vscode.postMessage({ type: meta.archived ? 'unarchiveConversation' : 'archiveConversation', conversationId: meta.id });
      });
      item.appendChild(actions);

      item.addEventListener('click', function () { vscode.postMessage({ type: 'loadConversation', conversationId: meta.id }); });
      els.historyList.appendChild(item);
    });
  }

  function replayConversation(conversation) {
    clearChat();
    currentGoal = conversation.goal || null;
    renderGoal(currentGoal);
    (conversation.events || []).forEach(function (e) { appendEvent(e); });
    closeHistory();
    scrollBottom(true);
  }

  // ---- Goal mode ----
  function goalInput() {
    var outcome = els.goalOutcome.value.trim();
    if (!outcome) { els.goalOutcome.focus(); return null; }
    return {
      outcome: outcome,
      constraints: els.goalConstraints.value.trim(),
      verification: els.goalVerification.value.trim(),
    };
  }

  function openGoalEditor(prefill) {
    if (planMode) togglePlanMode();
    var goal = currentGoal;
    els.goalOutcome.value = prefill || (goal ? goal.outcome : '');
    els.goalConstraints.value = goal ? (goal.constraints || '') : '';
    els.goalVerification.value = goal ? (goal.verification || '') : '';
    els.goalStart.textContent = goal && goal.status === 'paused' ? 'Resume goal' : goal ? 'Continue goal' : 'Start goal';
    els.goalStart.disabled = !!(state && state.isRunning);
    els.goalEditor.style.display = 'flex';
    els.goalOutcome.focus();
  }

  function closeGoalEditor() {
    els.goalEditor.style.display = 'none';
  }

  function saveGoal(start) {
    var goal = goalInput();
    if (!goal) return;
    closeGoalEditor();
    if (start) {
      if (state && state.isRunning) {
        vscode.postMessage({ type: 'setGoal', goal: goal });
        return;
      }
      appendUserMessage('Goal: ' + goal.outcome);
      vscode.postMessage({
        type: 'startTask', prompt: goal.outcome, goal: goal,
        agent: currentAgent(), route: currentRoute(), autonomy: currentAutonomy(),
        skills: selectedSkills.map(function (skill) { return skill.name; }),
      });
      selectedSkills = [];
      renderCtxChips();
    } else {
      vscode.postMessage({ type: 'setGoal', goal: goal });
    }
  }

  function goalControl(title, svg, className, onClick) {
    var button = document.createElement('button');
    button.type = 'button'; button.className = 'goal-control ' + (className || '');
    button.title = title; button.setAttribute('aria-label', title); button.innerHTML = svg;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderGoal(goal) {
    currentGoal = goal || null;
    if (!goal) { els.goalProgress.style.display = 'none'; els.goalProgress.innerHTML = ''; return; }
    els.goalProgress.innerHTML = '';
    els.goalProgress.style.display = 'flex';
    els.goalProgress.className = 'goal-progress status-' + goal.status;

    var target = document.createElement('span'); target.className = 'goal-target';
    target.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

    var text = document.createElement('div'); text.className = 'goal-copy';
    var title = document.createElement('div'); title.className = 'goal-title'; title.textContent = goal.outcome;
    var meta = document.createElement('div'); meta.className = 'goal-meta';
    meta.textContent = goal.status === 'completed' ? 'complete' : goal.status + (goal.verification ? ' · verified by definition of done' : '');
    text.appendChild(title); text.appendChild(meta);

    var controls = document.createElement('div'); controls.className = 'goal-controls';
    if (goal.status === 'running') {
      controls.appendChild(goalControl('Pause goal', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5v14M16 5v14"/></svg>', '', function () { vscode.postMessage({ type: 'pauseGoal' }); }));
    } else if (goal.status === 'paused') {
      controls.appendChild(goalControl('Resume goal', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l11 7-11 7z"/></svg>', '', function () { appendUserMessage('Continue goal: ' + goal.outcome); vscode.postMessage({ type: 'resumeGoal' }); }));
    }
    if (goal.status !== 'completed') {
      controls.appendChild(goalControl('Mark goal complete', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>', '', function () { vscode.postMessage({ type: 'completeGoal' }); }));
    }
    controls.appendChild(goalControl('Edit goal', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>', '', function () { openGoalEditor(''); }));
    controls.appendChild(goalControl('Clear goal', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>', 'clear', function () { vscode.postMessage({ type: 'clearGoal' }); }));
    els.goalProgress.appendChild(target); els.goalProgress.appendChild(text); els.goalProgress.appendChild(controls);
  }

  // ---- Skills ----
  function openSkillsPanel() {
    closeHistory();
    els.skillsPanel.style.display = 'flex';
    els.skillsSearch.value = '';
    els.skillsSearch.focus();
    vscode.postMessage({ type: 'listSkills' });
  }

  function closeSkillsPanel() { els.skillsPanel.style.display = 'none'; }

  function skillIsSelected(name) { return selectedSkills.some(function (skill) { return skill.name === name; }); }

  function toggleSkill(skill) {
    if (skillIsSelected(skill.name)) selectedSkills = selectedSkills.filter(function (item) { return item.name !== skill.name; });
    else selectedSkills.push(skill);
    renderSkillsList();
    renderCtxChips();
  }

  function renderSkillsList() {
    var query = (els.skillsSearch.value || '').trim().toLowerCase();
    els.skillsList.innerHTML = '';
    var visible = skills.filter(function (skill) {
      return !query || skill.name.toLowerCase().indexOf(query) >= 0 || (skill.description || '').toLowerCase().indexOf(query) >= 0;
    });
    if (!visible.length) {
      var empty = document.createElement('div'); empty.className = 'history-empty';
      empty.textContent = skills.length ? 'No matching skills.' : 'No skills found in .agents/skills.';
      els.skillsList.appendChild(empty); return;
    }
    visible.forEach(function (skill) {
      var row = document.createElement('button'); row.type = 'button';
      row.className = 'skill-row' + (skillIsSelected(skill.name) ? ' selected' : '');
      var head = document.createElement('div'); head.className = 'skill-row-head';
      var name = document.createElement('span'); name.className = 'skill-name'; name.textContent = '$' + skill.name;
      var source = document.createElement('span'); source.className = 'skill-source'; source.textContent = skill.scope;
      var description = document.createElement('div'); description.className = 'skill-description'; description.textContent = skill.description || 'No description provided.';
      var path = document.createElement('div'); path.className = 'skill-path'; path.textContent = skill.path;
      head.appendChild(name); head.appendChild(source); row.appendChild(head); row.appendChild(description); row.appendChild(path);
      row.addEventListener('click', function () { toggleSkill(skill); });
      els.skillsList.appendChild(row);
    });
  }

  function setSkills(next) {
    skills = Array.isArray(next) ? next : [];
    selectedSkills = selectedSkills.filter(function (selected) {
      var found = skills.filter(function (skill) { return skill.name === selected.name; })[0];
      if (found) { selected.description = found.description; selected.path = found.path; selected.scope = found.scope; return true; }
      return false;
    });
    if (els.skillsPanel.style.display !== 'none') renderSkillsList();
    renderCtxChips();
  }

  function skillNamesInText(text) {
    var names = [], seen = {}, re = /\$([A-Za-z0-9_-]+)/g, match;
    while ((match = re.exec(text || ''))) {
      var name = match[1];
      if (seen[name]) continue;
      var skill = skills.filter(function (item) { return item.name === name; })[0];
      if (skill) { names.push(name); seen[name] = true; }
    }
    return names;
  }

  function collectSkillsForSend(text) {
    var byName = {};
    selectedSkills.forEach(function (skill) { byName[skill.name] = true; });
    skillNamesInText(text).forEach(function (name) { byName[name] = true; });
    return Object.keys(byName);
  }

  function openSkillPicker() {
    var match = /(?:^|\s)\$([A-Za-z0-9_-]*)$/.exec(els.prompt.value);
    if (!match) return;
    var query = match[1].toLowerCase();
    var matches = skills.filter(function (skill) {
      return !query || skill.name.toLowerCase().indexOf(query) >= 0 || (skill.description || '').toLowerCase().indexOf(query) >= 0;
    }).slice(0, 8);
    if (!matches.length) return;
    openMenu(els.prompt, matches.map(function (skill) {
      return {
        label: '$' + skill.name + (skillIsSelected(skill.name) ? '  ✓' : ''),
        title: skill.description,
        onClick: function () {
          els.prompt.value = els.prompt.value.replace(/\$[A-Za-z0-9_-]*$/, '$' + skill.name + ' ');
          if (!skillIsSelected(skill.name)) toggleSkill(skill);
          els.prompt.focus();
        },
      };
    }));
  }

  function openCommandPicker() {
    var match = /^\/([a-z]*)$/.exec(els.prompt.value.trim().toLowerCase());
    if (!match) return;
    var commands = [
      { name: 'goal', label: '/goal', desc: 'Define outcome, constraints, and verification' },
      { name: 'skills', label: '/skills', desc: 'Browse and select reusable skills' },
      { name: 'agent', label: '/agent', desc: 'Switch the active agent' },
      { name: 'route', label: '/route', desc: 'Switch direct or proxy route' },
    ].filter(function (command) { return command.name.indexOf(match[1]) === 0; });
    if (!commands.length) return;
    openMenu(els.prompt, commands.map(function (command) {
      return { label: command.label, title: command.desc, onClick: function () {
        if (command.name === 'goal') openGoalEditor(''); else if (command.name === 'skills') openSkillsPanel(); else { els.prompt.value = command.label + ' '; els.prompt.focus(); }
      } };
    }));
  }

  // ---- Small floating menu helper (used by "Continue with" and future pickers) ----
  var openMenuEl = null;
  function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; document.removeEventListener('mousedown', onMenuOutside, true); document.removeEventListener('keydown', onMenuEscape, true); } }
  function onMenuOutside(e) { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }
  function onMenuEscape(e) { if (e.key === 'Escape') closeMenu(); }
  function openMenu(anchor, items) {
    closeMenu();
    var menu = document.createElement('div'); menu.className = 'kai-menu';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'kai-menu-item' + (it.disabled ? ' disabled' : '');
      row.textContent = it.label;
      if (it.title) row.title = it.title;
      if (!it.disabled) row.addEventListener('click', function () { closeMenu(); it.onClick(); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    var r = anchor.getBoundingClientRect();
    var top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    var left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = Math.max(4, top) + 'px';
    menu.style.left = Math.max(4, left) + 'px';
    openMenuEl = menu;
    setTimeout(function () {
      document.addEventListener('mousedown', onMenuOutside, true);
      document.addEventListener('keydown', onMenuEscape, true);
    }, 0);
  }

  // ---- Plan mode ----
  function togglePlanMode() { planMode=!planMode; if(planMode) closeGoalEditor(); els.planEditor.style.display=planMode?'block':'none'; els.planToggle.classList.toggle('active',planMode); els.planToggle.title=planMode?'Exit workflow mode':'Workflow mode: define multi-step agent runs'; if(planMode&&compareMode) toggleCompareMode(); }
  function addPlanStep() { planSteps.push({agent:currentAgent(),prompt:''}); renderPlanSteps(); }
  function removePlanStep(idx) { planSteps.splice(idx,1); renderPlanSteps(); }

  function renderPlanSteps() {
    els.planStepCount.textContent = planSteps.length+' step'+(planSteps.length!==1?'s':'');
    var h='';
    for(var i=0;i<planSteps.length;i++){
      var s=planSteps[i],ao='';
      for(var j=0;j<AGENT_IDS.length;j++){ var sel=AGENT_IDS[j]===s.agent?' selected':''; ao+='<option value="'+esc(AGENT_IDS[j])+'"'+sel+'>'+esc(AGENT_IDS[j])+'</option>'; }
      h+='<div class="plan-step-row"><span class="plan-step-idx">'+(i+1)+'</span><select class="plan-step-agent" data-idx="'+i+'">'+ao+'</select><textarea class="plan-step-prompt" data-idx="'+i+'" rows="2" placeholder="Step prompt...">'+esc(s.prompt)+'</textarea><button class="plan-step-remove" data-idx="'+i+'" title="Remove step">&times;</button></div>';
    }
    els.planSteps.innerHTML=h;
    els.planSteps.querySelectorAll('.plan-step-agent').forEach(function(el){ el.addEventListener('change',function(){ var idx=parseInt(el.getAttribute('data-idx'),10); if(planSteps[idx]) planSteps[idx].agent=el.value; }); });
    els.planSteps.querySelectorAll('.plan-step-prompt').forEach(function(el){ el.addEventListener('input',function(){ var idx=parseInt(el.getAttribute('data-idx'),10); if(planSteps[idx]) planSteps[idx].prompt=el.value; }); });
    els.planSteps.querySelectorAll('.plan-step-remove').forEach(function(el){ el.addEventListener('click',function(){ removePlanStep(parseInt(el.getAttribute('data-idx'),10)); }); });
  }

  function executePlan() {
    if(planSteps.length===0) return;
    var plan={id:'plan_'+Date.now(),title:els.planTitle.value.trim()||'Untitled workflow',steps:planSteps.map(function(s,i){return{id:'step_'+i,agent:s.agent,prompt:s.prompt.trim(),status:'pending'};}),route:currentRoute(),autonomy:currentAutonomy(),status:'ready',currentStepIndex:0,createdAt:new Date().toISOString()};
    removeEmpty(); appendUserMessage('Plan: '+plan.title+' ('+plan.steps.length+' steps)'); vscode.postMessage({type:'executePlan',value:JSON.stringify(plan)});
    togglePlanMode(); planSteps=[]; els.planTitle.value=''; renderPlanSteps();
  }

  function saveAsTemplate() {
    if(planSteps.length===0) return;
    var name = els.planTitle.value.trim()||'My workflow';
    var template={name:name,description:'',steps:planSteps.map(function(s){return{agent:s.agent,prompt:s.prompt};}),route:currentRoute(),autonomy:currentAutonomy()};
    vscode.postMessage({type:'saveTemplate',value:JSON.stringify(template)});
  }

  function loadTemplateIntoScreen(template) {
    els.planTitle.value = template.name||'';
    planSteps = template.steps.map(function(s){return{agent:s.agent,prompt:s.prompt};});
    renderPlanSteps();
    if(!planMode) togglePlanMode();
  }

  // Per-step live stats (cost, elapsed), keyed by step id — plan-runner.ts
  // gives each step run a taskId of `planstep_<step.id>_<timestamp>`.
  var planStepStats = {};
  function stepIdFromTaskId(taskId) {
    var m = /^planstep_(.+)_\d+$/.exec(taskId || '');
    return m ? m[1] : null;
  }
  function trackPlanStepStats(event) {
    var stepId = stepIdFromTaskId(event.taskId);
    if (!stepId) return;
    var stats = planStepStats[stepId] || (planStepStats[stepId] = { costUsd: undefined, inputTokens: 0, outputTokens: 0, startedAt: null, endedAt: null });
    if (event.type === 'agent.lifecycle' && event.status === 'starting') stats.startedAt = Date.now();
    if (event.type === 'agent.lifecycle' && (event.status === 'completed' || event.status === 'failed' || event.status === 'paused')) stats.endedAt = Date.now();
    if (event.type === 'cost.update') {
      if (event.inputTokens) stats.inputTokens += event.inputTokens;
      if (event.outputTokens) stats.outputTokens += event.outputTokens;
      if (event.amountUsd != null) stats.costUsd = event.amountUsd;
    }
  }
  function fmtStepStats(stepId) {
    var s = planStepStats[stepId];
    if (!s) return '';
    var parts = [];
    if (s.startedAt) parts.push(fmtElapsed((s.endedAt || Date.now()) - s.startedAt));
    if (s.costUsd != null) parts.push('$' + s.costUsd.toFixed(4));
    return parts.join(' · ');
  }

  function renderPlanProgress(plan) {
    if(!plan){ els.planProgress.style.display='none'; return; }
    els.planProgress.style.display='block';
    var totalCostForPlan = 0;
    plan.steps.forEach(function (s) { var st = planStepStats[s.id]; if (st && st.costUsd != null) totalCostForPlan += st.costUsd; });

    var h = '<div class="wf-header"><span class="wf-title">' + esc(plan.title) + '</span>' +
      '<span class="wf-meta">' + plan.steps.length + ' step' + (plan.steps.length !== 1 ? 's' : '') + (totalCostForPlan > 0 ? ' · $' + totalCostForPlan.toFixed(4) : '') + '</span>' +
      '<span class="pp-status status-' + plan.status + '">' + plan.status + '</span></div>';

    h += '<div class="wf-stepper">';
    for (var i = 0; i < plan.steps.length; i++) {
      var st = plan.steps[i];
      var nodeClass = st.status === 'completed' ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'running' ? 'running' : st.status === 'skipped' ? 'skipped' : 'pending';
      var nodeIcon = st.status === 'completed'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>'
        : st.status === 'failed'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
        : st.status === 'running'
        ? '<span class="spinner" style="width:10px;height:10px;"></span>'
        : '';
      h += '<div class="wf-step">' +
        '<div class="wf-rail"><span class="wf-node ' + nodeClass + '">' + nodeIcon + '</span>' + (i < plan.steps.length - 1 ? '<span class="wf-line"></span>' : '') + '</div>' +
        '<div class="wf-step-body">' +
        '<div class="wf-step-top"><span class="agent-dot ' + esc(st.agent) + '"></span><span class="wf-step-agent">' + esc(agentLabel(st.agent)) + '</span><span class="wf-step-stats">' + esc(fmtStepStats(st.id)) + '</span></div>' +
        '<div class="wf-step-label">' + esc(st.label || st.prompt.slice(0, 80)) + '</div>';
      if (st.status === 'failed' && plan.status === 'paused') {
        h += '<div class="wf-step-error">' + esc(st.error || 'Step failed') + '</div>' +
          '<div class="wf-step-actions">' +
          '<button class="turn-action-btn wide primary" data-retry="' + esc(st.id) + '">Retry</button>' +
          '<button class="turn-action-btn wide" data-retry-with="' + esc(st.id) + '">Retry with ▾</button>' +
          '<button class="turn-action-btn wide" data-edit-prompt="' + esc(st.id) + '">Edit prompt</button>' +
          '<button class="turn-action-btn wide" data-skip="' + esc(st.id) + '">Skip</button>' +
          '</div>' +
          '<div class="wf-step-edit" id="wf-edit-' + esc(st.id) + '" style="display:none;"></div>';
      } else if (st.error) {
        h += '<div class="wf-step-error">' + esc(st.error) + '</div>';
      }
      h += '</div></div>';
      if (i < plan.steps.length - 1) {
        h += '<div class="wf-handoff-note">Handoff to ' + esc(agentLabel(plan.steps[i + 1].agent)) + '</div>';
      }
    }
    h += '</div>';

    h += '<div class="wf-footer">';
    if (plan.status === 'running') { h += '<button id="pausePlanBtn" class="plan-ctrl-btn">Pause</button><button id="abortPlanBtn" class="plan-ctrl-btn abort">Abort</button>'; }
    else if (plan.status === 'paused') { h += '<button id="resumePlanBtn" class="plan-ctrl-btn">Resume</button><button id="abortPlanBtn" class="plan-ctrl-btn abort">Abort</button>'; }
    h += '</div>';

    els.planProgress.innerHTML = h;

    var pb=document.getElementById('pausePlanBtn'),rb=document.getElementById('resumePlanBtn'),ab=document.getElementById('abortPlanBtn');
    if(pb) pb.addEventListener('click',function(){vscode.postMessage({type:'pausePlan'});});
    if(rb) rb.addEventListener('click',function(){vscode.postMessage({type:'resumePlan'});});
    if(ab) ab.addEventListener('click',function(){vscode.postMessage({type:'abortPlan'});});

    els.planProgress.querySelectorAll('[data-retry]').forEach(function(btn){
      btn.addEventListener('click',function(){ vscode.postMessage({type:'retryStep',eventId:btn.getAttribute('data-retry')}); });
    });
    els.planProgress.querySelectorAll('[data-skip]').forEach(function(btn){
      btn.addEventListener('click',function(){ vscode.postMessage({type:'skipStep',eventId:btn.getAttribute('data-skip')}); });
    });
    els.planProgress.querySelectorAll('[data-retry-with]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var sid=btn.getAttribute('data-retry-with');
        var step=plan.steps.filter(function(s){return s.id===sid;})[0];
        var others=AGENT_IDS.filter(function(a){return !step||a!==step.agent;});
        openMenu(btn, others.map(function(a){
          return { label: agentLabel(a), disabled: !isAgentAvailable(a), onClick: function(){ vscode.postMessage({type:'retryStep',eventId:sid,agent:a}); } };
        }));
      });
    });
    els.planProgress.querySelectorAll('[data-edit-prompt]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var sid=btn.getAttribute('data-edit-prompt');
        var step=plan.steps.filter(function(s){return s.id===sid;})[0];
        var box=document.getElementById('wf-edit-'+sid);
        if(!box) return;
        if(box.style.display!=='none'){ box.style.display='none'; box.innerHTML=''; return; }
        box.style.display='block';
        var ta=document.createElement('textarea'); ta.className='wf-edit-textarea'; ta.rows=3; ta.value=step?step.prompt:'';
        var send=document.createElement('button'); send.type='button'; send.className='turn-action-btn wide primary'; send.textContent='Retry with this prompt';
        send.addEventListener('click',function(){ vscode.postMessage({type:'retryStep',eventId:sid,value:ta.value}); });
        box.appendChild(ta); box.appendChild(send);
      });
    });
  }

  function handlePlanEvent(planEvent) {
    switch(planEvent.type){
      case 'plan.started': els.planProgress.style.display='block'; els.planProgress.innerHTML='<div class="pp-header">Workflow started...</div>'; break;
      case 'plan.step.paused_for_retry': break;
      case 'plan.completed': case 'plan.aborted': renderPlanProgress(null); break;
      default: break;
    }
  }

  // ---- User messages ----
  function pinThinking() { if(thinkingEl&&els.chat.lastChild!==thinkingEl) els.chat.appendChild(thinkingEl); }
  var lastUserMsgEl = null;
  function appendUserMessage(text) {
    removeEmpty(); finalizeAssistant();
    var el=document.createElement('div'); el.className='msg user'; el.innerHTML='<span class="role">You</span>';
    el.appendChild(document.createTextNode(text));
    els.chat.appendChild(el); startThinking(); scrollBottom(true);
    lastUserMsgEl = el;
  }

  function attachRewindButton(userMsgEl, taskId) {
    if (userMsgEl.querySelector('.rewind-btn')) return;
    var btn = document.createElement('span'); btn.className = 'rewind-btn'; btn.title = 'Rewind code to here';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/></svg>';
    btn.addEventListener('click', function () {
      if (confirm('Revert every file this turn changed back to how it was before this message? This cannot be undone.')) {
        vscode.postMessage({ type: 'rewindToHere', taskId: taskId });
      }
    });
    userMsgEl.appendChild(btn);
  }
  function finalizeAssistant() { if(currentAssistant){currentAssistant.classList.remove('streaming');currentAssistant=null;} }

  // ---- Reply turns ----

  function toolIconSvg(name) {
    var n = (name || '').toLowerCase();
    if (/read|write|edit|file/.test(n)) {
      return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
    }
    if (/grep|search|find/.test(n)) {
      return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
    }
    if (/bash|shell|exec|command|run/.test(n)) {
      return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l6 6-6 6"/><path d="M12 19h8"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>';
  }

  function toolInputSummary(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.length > 80 ? input.slice(0, 80) + '…' : input;
    if (typeof input === 'object') {
      var key = ['file_path', 'path', 'command', 'pattern'].filter(function (k) { return typeof input[k] === 'string'; })[0];
      if (key) return input[key];
      try { var s = JSON.stringify(input); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch (e) { return ''; }
    }
    return String(input);
  }

  function ensureTurn(taskId, agent) {
    if (turns[taskId]) return turns[taskId];
    removeEmpty();
    finalizeAssistant();

    if (lastUserMsgEl) { attachRewindButton(lastUserMsgEl, taskId); lastUserMsgEl = null; }

    var meta = pendingTurnMeta[taskId];
    var el = document.createElement('div'); el.className = 'turn streaming';

    var header = document.createElement('div'); header.className = 'turn-header';
    var dot = document.createElement('span'); dot.className = 'agent-dot ' + (agent || '');
    var name = document.createElement('span'); name.className = 'agent-name'; name.textContent = agentLabel(agent);
    header.appendChild(dot); header.appendChild(name);
    if (meta && meta.modelName) {
      var routeChip = document.createElement('span'); routeChip.className = 'turn-chip';
      routeChip.textContent = (meta.route === 'proxy' ? 'Proxy' : 'Direct') + ' · ' + meta.modelName;
      header.appendChild(routeChip);
    }
    var costChip = document.createElement('span'); costChip.className = 'turn-chip cost'; costChip.style.display = 'none';
    header.appendChild(costChip);
    var elapsed = document.createElement('span'); elapsed.className = 'turn-elapsed'; elapsed.textContent = '0s';
    header.appendChild(elapsed);
    el.appendChild(header);

    var chipsRow = document.createElement('div'); chipsRow.className = 'turn-chips-row'; chipsRow.style.display = 'none';
    el.appendChild(chipsRow);

    var body = document.createElement('div'); body.className = 'turn-body';
    el.appendChild(body);

    els.chat.appendChild(el);

    var turn = {
      taskId: taskId,
      agent: agent,
      el: el,
      costChip: costChip,
      elapsedEl: elapsed,
      chipsRow: chipsRow,
      bodyEl: body,
      toolGroup: null,
      textEl: null,
      rawText: '',
      renderScheduled: false,
      startedAt: Date.now(),
      amountUsd: undefined,
      inputTokens: 0,
      outputTokens: 0,
      finalized: false,
    };
    turn.timerInterval = setInterval(function () {
      elapsed.textContent = fmtElapsed(Date.now() - turn.startedAt);
    }, 1000);
    turns[taskId] = turn;
    delete pendingTurnMeta[taskId];
    return turn;
  }

  function closeToolGroup(turn) { turn.toolGroup = null; }

  function appendToolCall(turn, event) {
    var group = turn.toolGroup;
    if (!group) {
      var card = document.createElement('div'); card.className = 'tool-group';
      var head = document.createElement('div'); head.className = 'tool-group-head';
      head.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>' +
        '<span class="tool-group-title">Ran 0 tools</span>' +
        '<span class="tool-group-tally"></span>' +
        '<svg class="chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
      var list = document.createElement('div'); list.className = 'tool-group-list';
      head.addEventListener('click', function () { card.classList.toggle('expanded'); });
      card.appendChild(head); card.appendChild(list);
      turn.bodyEl.appendChild(card);
      group = turn.toolGroup = { card: card, head: head, list: list, counts: {}, order: [], total: 0 };
    }
    group.total++;
    var toolName = event.name || 'unknown';
    if (group.counts[toolName] == null) { group.counts[toolName] = 0; group.order.push(toolName); }
    group.counts[toolName]++;
    group.head.querySelector('.tool-group-title').textContent = 'Ran ' + group.total + ' tool' + (group.total !== 1 ? 's' : '');
    group.head.querySelector('.tool-group-tally').textContent = group.order.map(function (n) {
      return n + (group.counts[n] > 1 ? ' ×' + group.counts[n] : '');
    }).join(' · ');

    var row = document.createElement('div'); row.className = 'tool-row';
    var icon = document.createElement('span'); icon.className = 'tool-row-icon'; icon.innerHTML = toolIconSvg(toolName);
    var nameEl = document.createElement('span'); nameEl.className = 'tool-row-name'; nameEl.textContent = toolName;
    var inputEl = document.createElement('span'); inputEl.className = 'tool-row-input'; inputEl.textContent = toolInputSummary(event.input);
    var statusEl = document.createElement('span'); statusEl.className = 'tool-row-status ' + (event.status || ''); statusEl.textContent = event.status || '';
    row.appendChild(icon); row.appendChild(nameEl); row.appendChild(inputEl); row.appendChild(statusEl);
    group.list.appendChild(row);
  }

  function appendChip(turn, className, text, detail) {
    turn.chipsRow.style.display = 'flex';
    var chip = document.createElement('span');
    chip.className = 'turn-chip ' + className + (detail ? ' clickable' : '');
    chip.textContent = text;
    turn.chipsRow.appendChild(chip);
    if (detail) {
      var open = false;
      var panel = null;
      chip.addEventListener('click', function () {
        open = !open;
        if (open) {
          panel = document.createElement('div'); panel.className = 'turn-chip-detail'; panel.textContent = detail;
          turn.bodyEl.insertBefore(panel, turn.bodyEl.firstChild);
          scrollBottom();
        } else if (panel) { panel.remove(); panel = null; }
      });
    }
    return chip;
  }

  function appendMemoryChip(turn, event) {
    var summary = event.summary || '';
    var m = summary.match(/Recall found (\d+)/);
    if (!m || m[1] === '0') return; // "No recall results found." or nothing usable — no chip.
    appendChip(turn, 'memory', 'Used ' + m[1] + ' ' + (m[1] === '1' ? 'memory' : 'memories'), summary);
  }

  function appendThoughtChip(turn, text) {
    appendChip(turn, '', 'Thought', text);
  }

  function renderTurnText(turn) {
    turn.renderScheduled = false;
    if (!turn.textEl) {
      turn.textEl = document.createElement('div'); turn.textEl.className = 'md-text';
      turn.bodyEl.appendChild(turn.textEl);
    }
    if (typeof window.kaiMarkdown === 'function') {
      turn.textEl.innerHTML = window.kaiMarkdown(turn.rawText);
    } else {
      turn.textEl.textContent = turn.rawText;
    }
  }

  function appendTurnText(turn, text) {
    closeToolGroup(turn);
    turn.rawText += text;
    if (!turn.renderScheduled) {
      turn.renderScheduled = true;
      requestAnimationFrame(function () { renderTurnText(turn); });
    }
  }

  function updateTurnCost(turn, event) {
    if (event.inputTokens) turn.inputTokens += event.inputTokens;
    if (event.outputTokens) turn.outputTokens += event.outputTokens;
    if (event.amountUsd != null) turn.amountUsd = event.amountUsd;
    var text = turn.amountUsd != null
      ? '$' + turn.amountUsd.toFixed(4)
      : (turn.inputTokens || turn.outputTokens) ? (turn.inputTokens + ' in / ' + turn.outputTokens + ' out') : '';
    if (text) { turn.costChip.textContent = text; turn.costChip.style.display = 'inline-flex'; }
    // The most recent turn's input tokens are the best available estimate of
    // context used so far (each new call resends/accumulates prior context).
    if (event.inputTokens) { lastKnownInputTokens = turn.inputTokens; renderContextMeter(); }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* best effort */ }
    ta.remove();
  }

  function isAgentAvailable(agent) {
    var cap = capabilitiesById[agent];
    return !cap || cap.available !== false;
  }

  function finalizeTurn(turn) {
    if (turn.finalized) return;
    turn.finalized = true;
    turn.el.classList.remove('streaming');
    if (turn.timerInterval) { clearInterval(turn.timerInterval); turn.timerInterval = null; }

    var actions = document.createElement('div'); actions.className = 'turn-actions';

    var copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'turn-action-btn'; copyBtn.title = 'Copy reply';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>';
    copyBtn.addEventListener('click', function () { copyToClipboard(turn.rawText); });
    actions.appendChild(copyBtn);

    var retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'turn-action-btn'; retryBtn.title = 'Retry with ' + agentLabel(turn.agent);
    retryBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
    retryBtn.addEventListener('click', function () {
      if (!lastUserPrompt || (state && state.isRunning)) return;
      appendUserMessage(lastUserPrompt);
      vscode.postMessage({ type: 'startTask', prompt: lastUserPrompt, agent: turn.agent, route: currentRoute(), autonomy: currentAutonomy() });
    });
    actions.appendChild(retryBtn);

    var continueBtn = document.createElement('button'); continueBtn.type = 'button'; continueBtn.className = 'turn-action-btn wide'; continueBtn.title = 'Hand off to another agent';
    continueBtn.innerHTML = 'Continue with <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    continueBtn.addEventListener('click', function () {
      var others = AGENT_IDS.filter(function (a) { return a !== turn.agent; });
      openMenu(continueBtn, others.map(function (a) {
        var available = isAgentAvailable(a);
        return {
          label: agentLabel(a) + (available ? '' : ' (unavailable)'),
          disabled: !available || (state && state.isRunning),
          title: !available && capabilitiesById[a] ? capabilitiesById[a].unavailableReason : undefined,
          onClick: function () { vscode.postMessage({ type: 'handoff', targetAgent: a }); },
        };
      }));
    });
    actions.appendChild(continueBtn);

    turn.bodyEl.appendChild(actions);
  }

  // ---- Composer: mode + agent/route chips ----

  function renderModeChip() {
    var mode = currentAutonomy();
    var info = MODES.filter(function (m) { return m.id === mode; })[0];
    els.modeChip.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/></svg> ' +
      esc(info ? info.label : mode) +
      ' <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    els.modeChip.classList.toggle('warn', !!(info && info.warn));
  }

  function renderAgentChip() {
    var agent = currentAgent(), route = currentRoute();
    els.agentChip.innerHTML =
      '<span class="agent-dot ' + agent + '"></span> ' + esc(agentLabel(agent)) + ' · ' + (route === 'proxy' ? 'Proxy' : 'Direct') +
      ' <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  }

  function openModeMenu() {
    var current = currentAutonomy();
    openMenuRich(els.modeChip, MODES.map(function (m) {
      return {
        label: m.label, desc: m.desc, selected: m.id === current, warn: m.warn,
        onClick: function () {
          if (m.id === 'custom') { openCustomPermissionsMenu(); return; }
          vscode.postMessage({ type: 'setAutonomy', autonomy: m.id });
        },
      };
    }));
  }

  function openCustomPermissionsMenu() {
    var keys = Object.keys(PERMISSION_KEYS);
    var menu = document.createElement('div'); menu.className = 'kai-menu';
    keys.forEach(function (key) {
      var info = PERMISSION_KEYS[key];
      var row = document.createElement('label'); row.className = 'kai-menu-item custom-perm-row';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!customPermissions[key];
      cb.addEventListener('change', function () {
        customPermissions[key] = cb.checked;
        vscode.postMessage({ type: 'setCustomPermissions', allowed: customPermissions });
      });
      var text = document.createElement('div'); text.className = 'custom-perm-text';
      var title = document.createElement('div'); title.className = 'title'; title.textContent = info.label;
      var desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = info.description;
      text.appendChild(title); text.appendChild(desc);
      row.appendChild(cb); row.appendChild(text);
      menu.appendChild(row);
    });
    var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'turn-action-btn wide'; apply.textContent = 'Use Custom mode';
    apply.style.marginTop = '4px';
    apply.addEventListener('click', function () { closeMenu(); vscode.postMessage({ type: 'setAutonomy', autonomy: 'custom' }); });
    menu.appendChild(apply);
    placeMenu(menu, els.modeChip);
  }

  function openAgentMenu() {
    var menu = document.createElement('div'); menu.className = 'kai-menu agent-menu';
    AGENT_IDS.forEach(function (a) {
      var available = isAgentAvailable(a);
      var row = document.createElement('div'); row.className = 'kai-menu-item agent-menu-row' + (a === currentAgent() ? ' selected' : '') + (!available ? ' disabled' : '');
      var dot = document.createElement('span'); dot.className = 'agent-dot ' + a;
      var name = document.createElement('span'); name.className = 'agent-menu-name'; name.textContent = agentLabel(a);
      row.appendChild(dot); row.appendChild(name);
      if (!available) {
        var install = document.createElement('span'); install.className = 'agent-menu-install'; install.textContent = 'Not installed';
        row.appendChild(install);
      } else {
        ['direct', 'proxy'].forEach(function (r) {
          var seg = document.createElement('span');
          seg.className = 'agent-menu-seg' + (r === currentRoute() && a === currentAgent() ? ' on' : '');
          seg.textContent = r === 'direct' ? 'Direct' : 'Proxy';
          seg.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: 'setAgent', agent: a });
            vscode.postMessage({ type: 'setRoute', route: r });
            closeMenu();
          });
          row.appendChild(seg);
        });
        var model = document.createElement('span'); model.className = 'agent-menu-model';
        var models = AGENT_MODELS[a];
        model.textContent = models ? (currentRoute() === 'proxy' ? models.proxy : models.direct) : '';
        row.appendChild(model);
      }
      if (available) {
        row.addEventListener('click', function () { vscode.postMessage({ type: 'setAgent', agent: a }); closeMenu(); });
      }
      menu.appendChild(row);
    });
    placeMenu(menu, els.agentChip);
  }

  // Richer popover for the mode menu: title + description per row.
  function openMenuRich(anchor, items) {
    closeMenu();
    var menu = document.createElement('div'); menu.className = 'kai-menu';
    items.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'kai-menu-item rich' + (it.selected ? ' selected' : '');
      var text = document.createElement('div'); text.className = 'rich-text';
      var title = document.createElement('div'); title.className = 'title' + (it.warn ? ' warn' : ''); title.textContent = it.label;
      var desc = document.createElement('div'); desc.className = 'desc'; desc.textContent = it.desc || '';
      text.appendChild(title); text.appendChild(desc);
      row.appendChild(text);
      if (it.selected) {
        var check = document.createElement('span'); check.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
        row.appendChild(check);
      }
      row.addEventListener('click', function () { closeMenu(); it.onClick(); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    placeMenuPositioned(menu, anchor);
  }

  function placeMenu(menu, anchor) {
    document.body.appendChild(menu);
    placeMenuPositioned(menu, anchor);
    openMenuEl = menu;
    setTimeout(function () {
      document.addEventListener('mousedown', onMenuOutside, true);
      document.addEventListener('keydown', onMenuEscape, true);
    }, 0);
  }
  function placeMenuPositioned(menu, anchor) {
    var r = anchor.getBoundingClientRect();
    var top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    var left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = Math.max(4, top) + 'px';
    menu.style.left = Math.max(4, left) + 'px';
    if (!openMenuEl) {
      openMenuEl = menu;
      setTimeout(function () {
        document.addEventListener('mousedown', onMenuOutside, true);
        document.addEventListener('keydown', onMenuEscape, true);
      }, 0);
    }
  }

  // ---- Composer: context chips (@) ----
  var activeFile = null; // {path, included}
  var contextChips = []; // {type, path, startLine, endLine, name, key}

  function chipKey(c) { return c.type + ':' + (c.path || c.name || c.query || ''); }
  function addContextChip(chip) {
    var key = chipKey(chip);
    if (contextChips.some(function (c) { return chipKey(c) === key; })) return;
    contextChips.push(chip);
    renderCtxChips();
  }
  function removeContextChip(key) {
    contextChips = contextChips.filter(function (c) { return chipKey(c) !== key; });
    renderCtxChips();
  }
  function chipDisplayText(c) {
    switch (c.type) {
      case 'file': return c.path;
      case 'selection': return c.path + ':' + c.startLine + '-' + c.endLine;
      case 'gitDiff': return 'Uncommitted changes';
      case 'memory': return 'Memory: ' + c.query;
      case 'image': return c.name;
      default: return c.type;
    }
  }
  function renderCtxChips() {
    var hasAny = (activeFile != null) || contextChips.length > 0 || selectedSkills.length > 0;
    els.ctxChipRow.style.display = hasAny ? 'flex' : 'none';
    els.ctxChipRow.innerHTML = '';
    if (activeFile) {
      var afChip = document.createElement('span'); afChip.className = 'ctx-chip' + (activeFile.included ? '' : ' excluded');
      afChip.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg> ' +
        esc(activeFile.path) + ' <span class="eye" title="' + (activeFile.included ? 'Exclude' : 'Include') + '">' +
        (activeFile.included
          ? '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
          : '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.2A11 11 0 0 1 12 5c7 0 11 7 11 7a13.2 13.2 0 0 1-3.2 3.9M6.6 6.6C4 8.3 2 11 2 12c0 0 4 7 11 7 1.4 0 2.7-.2 3.9-.6"/></svg>') +
        '</span>';
      afChip.querySelector('.eye').addEventListener('click', function () { activeFile.included = !activeFile.included; renderCtxChips(); });
      els.ctxChipRow.appendChild(afChip);
    }
    selectedSkills.forEach(function (skill) {
      var chip = document.createElement('span'); chip.className = 'ctx-chip skill-chip';
      chip.appendChild(document.createTextNode('$' + skill.name));
      var rm = document.createElement('span'); rm.className = 'rm'; rm.textContent = '×'; rm.title = 'Remove skill';
      rm.addEventListener('click', function () { selectedSkills = selectedSkills.filter(function (item) { return item.name !== skill.name; }); renderCtxChips(); });
      chip.appendChild(rm);
      els.ctxChipRow.appendChild(chip);
    });
    contextChips.forEach(function (c) {
      var chip = document.createElement('span'); chip.className = 'ctx-chip';
      chip.appendChild(document.createTextNode(chipDisplayText(c)));
      var rm = document.createElement('span'); rm.className = 'rm'; rm.textContent = '×'; rm.title = 'Remove';
      rm.addEventListener('click', function () { removeContextChip(chipKey(c)); });
      chip.appendChild(rm);
      els.ctxChipRow.appendChild(chip);
    });
  }

  function collectChipsForSend() {
    var out = [];
    if (activeFile && activeFile.included) out.push({ type: 'file', path: activeFile.path });
    contextChips.forEach(function (c) {
      if (c.type === 'file') out.push({ type: 'file', path: c.path });
      else if (c.type === 'selection') out.push({ type: 'selection', path: c.path, startLine: c.startLine, endLine: c.endLine });
      else if (c.type === 'gitDiff') out.push({ type: 'gitDiff', stat: c.stat });
      else if (c.type === 'memory') out.push({ type: 'memory', query: c.query, summary: c.summary });
      else if (c.type === 'image') out.push({ type: 'image', name: c.name });
    });
    return out;
  }
  function clearNonPersistentChips() { contextChips = []; renderCtxChips(); }

  function openAtMenu() {
    var menu = document.createElement('div'); menu.className = 'kai-menu at-menu';
    var searchWrap = document.createElement('div'); searchWrap.className = 'at-search-wrap';
    var search = document.createElement('input'); search.type = 'text'; search.placeholder = 'Search files…'; search.className = 'at-search';
    searchWrap.appendChild(search); menu.appendChild(searchWrap);
    var results = document.createElement('div'); results.className = 'at-results'; menu.appendChild(results);

    var staticWrap = document.createElement('div'); staticWrap.className = 'at-static';
    function staticRow(label, hint, onClick) {
      var row = document.createElement('div'); row.className = 'kai-menu-item';
      row.innerHTML = '<span>' + esc(label) + '</span>';
      if (hint) { var h = document.createElement('span'); h.style.marginLeft = 'auto'; h.style.opacity = '0.7'; h.style.fontSize = '10px'; h.textContent = hint; row.appendChild(h); }
      row.addEventListener('click', function () { closeMenu(); onClick(); });
      staticWrap.appendChild(row);
    }
    staticRow('Current selection', '', function () { vscode.postMessage({ type: 'requestSelection' }); });
    staticRow('Uncommitted changes', '', function () { vscode.postMessage({ type: 'requestGitDiffStat' }); });
    staticRow('Search memory', '', function () {
      var q = prompt('Search memory for:');
      if (q && q.trim()) vscode.postMessage({ type: 'requestMemorySearch', query: q.trim() });
    });
    menu.appendChild(staticWrap);

    document.body.appendChild(menu);
    placeMenuPositioned(menu, els.atBtn);
    search.focus();

    var searchTimer = null;
    search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = search.value;
      searchTimer = setTimeout(function () { vscode.postMessage({ type: 'searchFiles', query: q }); }, 200);
    });
    window.__kaiAtResultsEl = results; // populated by the searchFilesResult handler while this menu is open
    vscode.postMessage({ type: 'searchFiles', query: '' });
  }

  function renderAtResults(files) {
    var results = window.__kaiAtResultsEl;
    if (!results || !openMenuEl || !openMenuEl.contains(results)) return;
    results.innerHTML = '';
    files.forEach(function (f) {
      var row = document.createElement('div'); row.className = 'kai-menu-item';
      row.textContent = f.path;
      row.addEventListener('click', function () { closeMenu(); addContextChip({ type: 'file', path: f.path }); });
      results.appendChild(row);
    });
  }

  // ---- Composer: context meter ----
  var lastKnownInputTokens = 0;
  function renderContextMeter() {
    var windows = CONTEXT_WINDOWS[currentAgent()];
    var windowSize = windows ? windows[currentRoute()] : 0;
    if (!windowSize || !lastKnownInputTokens) { els.ctxMeter.style.display = 'none'; return; }
    var pct = Math.min(100, Math.round((lastKnownInputTokens / windowSize) * 100));
    var r = 6, c = 2 * Math.PI * r;
    els.ctxMeter.style.display = 'inline-flex';
    els.ctxMeter.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="' + r + '" fill="none" stroke="var(--kai-border)" stroke-width="2"/>' +
      '<circle cx="8" cy="8" r="' + r + '" fill="none" stroke="var(--kai-accent)" stroke-width="2" stroke-dasharray="' + (c * pct / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 8 8)"/></svg> ' +
      pct + '%';
  }

  // ---- Composer: message queue (queue while running, steer now) ----
  var messageQueue = [];
  function renderQueue() {
    els.queueList.innerHTML = '';
    els.queueList.style.display = messageQueue.length ? 'flex' : 'none';
    messageQueue.forEach(function (item, idx) {
      var row = document.createElement('div'); row.className = 'queue-row';
      var label = document.createElement('span'); label.className = 'label'; label.textContent = 'Queued';
      var text = document.createElement('span'); text.className = 'queue-text'; text.textContent = item.text;
      var editBtn = document.createElement('span'); editBtn.className = 'ibtn small'; editBtn.title = 'Edit';
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
      editBtn.addEventListener('click', function () { els.prompt.value = item.text; autoGrow(); messageQueue.splice(idx, 1); renderQueue(); els.prompt.focus(); });
      var rmBtn = document.createElement('span'); rmBtn.className = 'ibtn small'; rmBtn.title = 'Remove';
      rmBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      rmBtn.addEventListener('click', function () { messageQueue.splice(idx, 1); renderQueue(); });
      row.appendChild(label); row.appendChild(text); row.appendChild(editBtn); row.appendChild(rmBtn);
      els.queueList.appendChild(row);
    });
  }
  function sendNextQueued() {
    if (messageQueue.length && !(state && state.isRunning)) {
      var item = messageQueue.shift();
      renderQueue();
      reallyDispatch(item.text);
    }
  }

  // ---- Legacy generic event cards (diff/approval/error/tool fallback) ----
  function cardClass(e) { switch(e.type){case'tool.call':return'tool';case'diff.proposal':case'file.edit.applied':return'diff';case'approval.request':return'approval';case'error':return'error';case'cost.update':return'cost';case'memory.event':return'memory';case'agent.lifecycle':case'autonomy.changed':case'route.changed':return'lifecycle';default:return'raw';} }
  function eventLabel(e) { var L={'tool.call':'Tool Call','diff.proposal':'Diff','file.edit.applied':'Edit Applied','approval.request':'Approval','error':'Error','cost.update':'Cost','memory.event':'Memory','agent.lifecycle':'Lifecycle','autonomy.changed':'Autonomy','route.changed':'Route','permission.escalation':'Permission','raw.fallback':'Raw'}; return L[e.type]||e.type; }
  var TELEMETRY={'agent.lifecycle':1,'autonomy.changed':1,'route.changed':1,'cost.update':1,'memory.event':1,'raw.fallback':1};
  function isTelemetry(type) { return !!TELEMETRY[type]; }

  // Only refreshes the topbar cost pill — never routes through renderState(),
  // which would also re-evaluate the running/thinking UI and (since a turn's
  // own header timer replaces the spinner once content starts) incorrectly
  // restart it on every cost update that arrives mid-run.
  function updateCostPill() { if(totalCost>0) els.costPill.innerHTML='<span class="pill cost">$'+totalCost.toFixed(4)+' . '+totalInput+' in / '+totalOutput+' out</span>'; }
  function accumulateCost(event) { if(event.inputTokens) totalInput+=event.inputTokens; if(event.outputTokens) totalOutput+=event.outputTokens; if(event.amountUsd!=null) totalCost=event.amountUsd; updateCostPill(); }
  function telemetryText(event) { switch(event.type){case'cost.update':return[event.inputTokens!=null?'In '+event.inputTokens:'',event.outputTokens!=null?'Out '+event.outputTokens:'',event.amountUsd!=null?'$'+event.amountUsd.toFixed(4):''].filter(Boolean).join(' . ');case'memory.event':return(event.action?event.action+': ':'')+(event.summary||'');case'raw.fallback':var p=typeof event.payload==='string'?event.payload:JSON.stringify(event.payload);return p.length>240?p.slice(0,240)+'...':p;default:return event.detail||event.summary||event.message||'';} }

  function renderTelemetry(event) { var row=document.createElement('div');row.className='log-row telemetry';var tag=document.createElement('span');tag.className='log-tag';tag.textContent=eventLabel(event)+(event.agent?' . '+event.agent:'');row.appendChild(tag);row.appendChild(document.createTextNode(telemetryText(event)));return row; }

  function fmtFileStat(f) {
    var parts = [];
    if (f.added) parts.push('+' + f.added);
    if (f.removed) parts.push('−' + f.removed);
    return parts.join(' ');
  }

  function renderCompareSummary(payload) {
    var panes = document.getElementById('compare-panes');
    if (!panes) return;
    var old = document.getElementById('compare-summary-' + payload.compareId); if (old) old.remove();
    var box = document.createElement('div'); box.id = 'compare-summary-' + payload.compareId; box.className = 'compare-summary';
    [payload.left, payload.right].forEach(function (side, idx) {
      var sideKey = idx === 0 ? 'left' : 'right';
      var col = document.createElement('div'); col.className = 'cmp-result-col';
      var files = side.files || [];
      var added = 0, removed = 0; files.forEach(function (f) { added += f.added || 0; removed += f.removed || 0; });
      col.innerHTML =
        '<div class="cmp-agent-row"><span class="agent-dot"></span><strong class="cmp-agent">' + esc(agentLabel(side.agent)) + '</strong>' +
        '<span class="cmp-ok ' + (side.ok ? 'ok' : 'fail') + '">' + (side.ok ? 'OK' : 'Failed') + '</span></div>' +
        '<div class="cmp-stat-row">' + fmtElapsed(side.elapsedMs || 0) +
        (files.length ? ' · ' + files.length + ' file' + (files.length !== 1 ? 's' : '') + ' <span class="add">+' + added + '</span> <span class="remove">−' + removed + '</span>' : ' · no changes') + '</div>';
      col.querySelector('.agent-dot').className = 'agent-dot ' + side.agent;
      if (side.error) { var errEl = document.createElement('div'); errEl.className = 'cmp-error'; errEl.textContent = side.error; col.appendChild(errEl); }
      var actions = document.createElement('div'); actions.className = 'cmp-actions';
      var pick = document.createElement('button'); pick.type = 'button'; pick.className = 'turn-action-btn wide primary'; pick.textContent = 'Pick this one';
      pick.addEventListener('click', function () {
        vscode.postMessage({ type: 'pickCompareWinner', compareId: payload.compareId, side: sideKey });
        box.querySelectorAll('.cmp-actions').forEach(function (a) { a.remove(); });
        var note = document.createElement('div'); note.className = 'cmp-picked-note'; note.textContent = 'Applied to your workspace.';
        col.appendChild(note);
      });
      var openWt = document.createElement('button'); openWt.type = 'button'; openWt.className = 'turn-action-btn wide'; openWt.textContent = 'Open worktree';
      openWt.addEventListener('click', function () { vscode.postMessage({ type: 'openCompareWorktree', compareId: payload.compareId, side: sideKey }); });
      actions.appendChild(pick); actions.appendChild(openWt);
      col.appendChild(actions);
      box.appendChild(col);
    });
    var discardRow = document.createElement('div'); discardRow.className = 'cmp-discard-row';
    var discard = document.createElement('button'); discard.type = 'button'; discard.className = 'turn-action-btn'; discard.textContent = 'Discard both';
    discard.addEventListener('click', function () { vscode.postMessage({ type: 'discardCompare', compareId: payload.compareId }); box.remove(); });
    discardRow.appendChild(discard);
    box.appendChild(discardRow);
    panes.parentNode.insertBefore(box, panes.nextSibling);
  }

  function renderTurnChangesCard(event, turn) {
    var totalAdded = 0, totalRemoved = 0;
    (event.files || []).forEach(function (f) { totalAdded += f.added || 0; totalRemoved += f.removed || 0; });
    var card = document.createElement('div'); card.className = 'changes-card';
    var head = document.createElement('div'); head.className = 'changes-head';
    var count = event.files.length;
    head.innerHTML =
      '<span class="changes-title">' + count + ' file' + (count !== 1 ? 's' : '') + ' changed</span>' +
      (totalAdded ? '<span class="mono add">+' + totalAdded + '</span>' : '') +
      (totalRemoved ? '<span class="mono remove">−' + totalRemoved + '</span>' : '');
    card.appendChild(head);
    var list = document.createElement('div'); list.className = 'changes-list';
    event.files.forEach(function (f) {
      var row = document.createElement('div'); row.className = 'changes-row';
      var p = document.createElement('span'); p.className = 'mono path'; p.textContent = f.path;
      var stat = document.createElement('span'); stat.className = 'mono stat';
      stat.innerHTML = (f.added ? '<span class="add">+' + f.added + '</span>' : '') + (f.removed ? '<span class="remove">−' + f.removed + '</span>' : '');
      row.appendChild(p); row.appendChild(stat);
      list.appendChild(row);
    });
    card.appendChild(list);
    var actions = document.createElement('div'); actions.className = 'changes-actions';
    var reviewBtn = document.createElement('button'); reviewBtn.type = 'button'; reviewBtn.className = 'turn-action-btn wide primary'; reviewBtn.textContent = 'Review in editor';
    reviewBtn.addEventListener('click', function () { vscode.postMessage({ type: 'reviewChanges', taskId: event.taskId }); });
    var keepBtn = document.createElement('button'); keepBtn.type = 'button'; keepBtn.className = 'turn-action-btn wide'; keepBtn.textContent = 'Keep all';
    keepBtn.addEventListener('click', function () { actions.remove(); });
    var undoBtn = document.createElement('button'); undoBtn.type = 'button'; undoBtn.className = 'turn-action-btn wide'; undoBtn.textContent = 'Undo all';
    undoBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'undoAllChanges', taskId: event.taskId });
      card.classList.add('reverted'); actions.remove();
      var note = document.createElement('div'); note.className = 'changes-reverted-note'; note.textContent = 'Reverted.';
      card.appendChild(note);
    });
    actions.appendChild(reviewBtn); actions.appendChild(keepBtn); actions.appendChild(undoBtn);
    card.appendChild(actions);
    return card;
  }

  function renderApprovalCard(event) {
    var card = document.createElement('div'); card.className = 'approval-card';
    var head = document.createElement('div'); head.className = 'approval-head';
    head.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/></svg>' +
      '<span class="approval-title">' + esc(event.title) + '</span>' +
      '<span class="approval-risk risk-' + esc(event.risk) + '">' + esc(event.risk) + ' risk</span>';
    card.appendChild(head);
    if (event.detail) {
      var detailEl = document.createElement('div'); detailEl.className = 'approval-detail mono'; detailEl.textContent = event.detail;
      card.appendChild(detailEl);
    }
    var actions = document.createElement('div'); actions.className = 'approval-actions-row';
    function respond(response) {
      vscode.postMessage({ type: 'respondToApproval', eventId: event.id, response: response });
      actions.innerHTML = '';
      var note = document.createElement('div'); note.className = 'approval-resolved';
      note.textContent = response === 'deny' ? 'Denied.' : response === 'always' ? 'Always allowed.' : 'Allowed once.';
      card.appendChild(note);
    }
    var allowOnce = document.createElement('button'); allowOnce.type = 'button'; allowOnce.className = 'turn-action-btn wide primary'; allowOnce.textContent = 'Allow once';
    allowOnce.addEventListener('click', function () { respond('once'); });
    var allowAlways = document.createElement('button'); allowAlways.type = 'button'; allowAlways.className = 'turn-action-btn wide'; allowAlways.textContent = 'Always allow ' + event.title;
    allowAlways.addEventListener('click', function () { respond('always'); });
    var deny = document.createElement('button'); deny.type = 'button'; deny.className = 'turn-action-btn wide'; deny.textContent = 'Deny';
    deny.addEventListener('click', function () { respond('deny'); });
    actions.appendChild(allowOnce); actions.appendChild(allowAlways); actions.appendChild(deny);
    card.appendChild(actions);
    return card;
  }

  function renderCard(event) {
    var card=document.createElement('div');card.className='event-card '+cardClass(event);
    var hdr=document.createElement('div');hdr.className='event-header';hdr.innerHTML='<span class="event-source">'+eventLabel(event)+(event.agent?' . '+esc(event.agent):'')+'</span><span>'+fmtTime(event.timestamp)+'</span>';card.appendChild(hdr);
    var body=document.createElement('div');body.className='event-body';
    switch(event.type){
      case'tool.call':body.innerHTML='<span class="tool-name">'+esc(event.name)+'</span> <span class="tool-status">'+esc(event.status)+'</span>';if(event.input){var pre=document.createElement('div');pre.className='diff-preview';pre.textContent=JSON.stringify(event.input,null,2);body.appendChild(pre);}break;
      case'diff.proposal':body.innerHTML='<div class="diff-summary">'+esc(event.filePath)+'</div><div>'+esc(event.summary)+'</div>';if(event.diff){var dp=document.createElement('div');dp.className='diff-preview';dp.textContent=event.diff;body.appendChild(dp);}var actions=document.createElement('div');actions.className='approval-actions';actions.innerHTML='<button data-approve="'+esc(event.id)+'">Approve</button><button class="secondary" data-reject="'+esc(event.id)+'">Reject</button>';body.appendChild(actions);break;
      case'file.edit.applied':body.innerHTML='<div class="diff-summary">'+esc(event.filePath)+'</div><div>'+esc(event.summary)+'</div>';break;
      case'approval.request':body.innerHTML='<strong>'+esc(event.title)+'</strong> <span class="risk-'+esc(event.risk)+'">['+esc(event.risk)+' risk]</span><div>'+esc(event.detail)+'</div>';break;
      case'error':body.textContent=event.message;break;
      case'cost.update':body.innerHTML='<div class="cost-detail">'+(event.inputTokens!=null?'In: '+event.inputTokens+' tk':'')+(event.outputTokens!=null?' | Out: '+event.outputTokens+' tk':'')+(event.amountUsd!=null?' | $'+event.amountUsd.toFixed(4):'')+'</div>';break;
      case'memory.event':body.innerHTML='<span class="memory-action">'+esc(event.action)+'</span><div>'+esc(event.summary)+'</div>';break;
      default:body.textContent=event.detail||event.summary||event.message||'';
    }
    card.appendChild(body);return card;
  }

  function activityDetail(event) { switch(event.type){case'tool.call':return(event.name||'tool')+(event.status&&event.status!=='started'?' . '+event.status:'');case'diff.proposal':return'Editing '+(event.filePath||'file');case'file.edit.applied':return'Applied edit to '+(event.filePath||'file');case'memory.event':return event.action?'Memory: '+event.action:'';case'agent.lifecycle':return event.detail||'';default:return'';} }

  var currentCompareId = null;
  function appendEvent(event) {
    if(event.compareId){
      if (event.compareId !== currentCompareId) {
        // A new compare run — drop any stale panes/labels from a previous one.
        currentCompareId = event.compareId;
        activeCompare = { left: event.side==='left'?event.agent:'', right: event.side==='right'?event.agent:'' };
        var stale = document.getElementById('compare-panes'); if (stale) stale.remove();
      }
      if (activeCompare && !activeCompare[event.side] && event.agent) activeCompare[event.side] = event.agent;
      if(!document.getElementById('compare-panes')){
        var panes=document.createElement('div');panes.id='compare-panes';
        panes.innerHTML='<div class="compare-pane left" id="cp-left"><div class="compare-label">'+esc(activeCompare.left||'Left')+'</div></div><div class="compare-pane right" id="cp-right"><div class="compare-label">'+esc(activeCompare.right||'Right')+'</div></div>';
        els.chat.appendChild(panes); removeEmpty();
      }
      var tp=document.getElementById(event.side==='left'?'cp-left':'cp-right'); if(!tp) return;
      if(event.type==='text.delta'){ var t=document.createElement('span');t.className='cmp-text';t.textContent=event.text; tp.appendChild(t); }
      else if(event.type==='raw.fallback'&&event.sourceType==='compare.complete'){ renderCompareSummary(event.payload); }
      else if(event.type==='cost.update') accumulateCost(event);
      scrollBottom(true); return;
    }

    var detail = activityDetail(event);
    if (detail) setThinkingDetail(detail);

    trackPlanStepStats(event);

    // Route agent-attributable events with a real taskId into their turn.
    var taskId = event.taskId;
    var isTurnEvent = taskId && taskId !== 'workbench' && event.agent;
    if (isTurnEvent) {
      var turn = ensureTurn(taskId, event.agent);
      removeEmpty(); finalizeAssistant(); stopThinking();

      if (event.type === 'text.delta') {
        if (event.channel === 'summary') { appendThoughtChip(turn, event.text); }
        else { appendTurnText(turn, event.text); }
        pinThinking(); scrollBottom(); return;
      }
      if (event.type === 'tool.call') { appendToolCall(turn, event); pinThinking(); scrollBottom(); return; }
      if (event.type === 'memory.event') {
        if (event.action === 'recall') { appendMemoryChip(turn, event); pinThinking(); scrollBottom(); return; }
        turn.bodyEl.appendChild(renderTelemetry(event)); return;
      }
      if (event.type === 'cost.update') { updateTurnCost(turn, event); accumulateCost(event); return; }
      if (event.type === 'turn.changes') { closeToolGroup(turn); turn.bodyEl.appendChild(renderTurnChangesCard(event, turn)); scrollBottom(); return; }
      if (event.type === 'approval.request') { closeToolGroup(turn); turn.bodyEl.appendChild(renderApprovalCard(event)); pinThinking(); scrollBottom(); return; }
      if (event.type === 'diff.proposal' || event.type === 'file.edit.applied' || event.type === 'error') {
        closeToolGroup(turn);
        turn.bodyEl.appendChild(renderCard(event));
        // A bare error (e.g. "agent unavailable") can end a turn with no
        // terminal agent.lifecycle event following it — finalize here too,
        // so the turn doesn't stay "streaming" with a timer that never stops.
        if (event.type === 'error') finalizeTurn(turn);
        pinThinking(); scrollBottom(); return;
      }
      if (event.type === 'agent.lifecycle') {
        // 'paused' covers both a user-initiated stop and a handoff pause —
        // either way this turn's run is over and needs its actions + a
        // stopped timer, same as completed/failed.
        if (event.status === 'completed' || event.status === 'failed' || event.status === 'paused') { finalizeTurn(turn); }
        else { turn.bodyEl.appendChild(renderTelemetry(event)); }
        scrollBottom(); return;
      }
      // Other telemetry (autonomy.changed, route.changed, raw.fallback, permission.escalation)
      turn.bodyEl.appendChild(renderTelemetry(event));
      pinThinking(); scrollBottom(); return;
    }

    // Fallback for events with no agent/taskId context (workbench-level errors etc.)
    if(event.type==='text.delta'){appendAssistantTextFallback(event.text,event.agent);return;}
    if(event.type==='cost.update') accumulateCost(event);
    removeEmpty(); finalizeAssistant();
    if(isTelemetry(event.type)){els.chat.appendChild(renderTelemetry(event));}else{els.chat.appendChild(renderCard(event));}
    pinThinking(); scrollBottom();
  }

  // Only used for the no-taskId fallback path above; normal replies go through appendTurnText.
  function appendAssistantTextFallback(text,agent) { removeEmpty(); if(!currentAssistant){ currentAssistant=document.createElement('div');currentAssistant.className='msg assistant streaming';var role=document.createElement('span');role.className='role';role.textContent=agent||(state&&state.activeAgent)||'Assistant';currentAssistant.appendChild(role);currentAssistant.appendChild(document.createTextNode(''));els.chat.appendChild(currentAssistant); } var last=currentAssistant.lastChild; if(last&&last.nodeType===3) last.nodeValue+=text; else currentAssistant.appendChild(document.createTextNode(text)); pinThinking(); scrollBottom(); }

  var wasRunning = false;
  function renderState(next) {
    state=next;
    var running=state.isRunning;
    els.planToggle.disabled=running;
    if (els.goalStart) els.goalStart.disabled = running;
    if(running){els.send.textContent='Stop';els.send.classList.add('stop');startThinking();}else{els.send.textContent='Send';els.send.classList.remove('stop');finalizeAssistant();stopThinking();}
    els.statePill.innerHTML=running?'<span class="pill running"><span class="dot"></span>running</span>':'<span class="pill"><span class="dot"></span>idle</span>';
    if(totalCost>0) els.costPill.innerHTML='<span class="pill cost">$'+totalCost.toFixed(4)+' . '+totalInput+' in / '+totalOutput+' out</span>';
    renderModeChip(); renderAgentChip(); renderContextMeter();
    if (totalCost > 0) { els.sessionMeta.textContent = 'Session $' + totalCost.toFixed(4) + ' · ' + (totalInput + totalOutput).toLocaleString() + ' tokens'; }
    if (wasRunning && !running) { setTimeout(sendNextQueued, 0); }
    wasRunning = running;
  }

  function applyCapabilities(capabilities) {
    capabilitiesById = {};
    (capabilities || []).forEach(function (c) { capabilitiesById[c.id] = c; });
    renderAgentChip();
  }

  var compareMode = false;
  function toggleCompareMode() {
    compareMode = !compareMode;
    els.compareAgentB.style.display = compareMode ? 'inline-flex' : 'none';
    els.compareToggle.classList.toggle('active', compareMode);
    if (compareMode && planMode) togglePlanMode();
  }

  function reallyDispatch(text) {
    lastUserPrompt = text;
    var chips = collectChipsForSend();
    var skillNames = collectSkillsForSend(text);
    appendUserMessage(text);
    if (compareMode) {
      vscode.postMessage({ type: 'compareTask', prompt: text, agent: currentAgent(), targetAgent: els.compareAgentB.value });
    } else {
      vscode.postMessage({ type: 'startTask', prompt: text, agent: currentAgent(), route: currentRoute(), autonomy: currentAutonomy(), contextChips: chips, skills: skillNames });
    }
    clearNonPersistentChips();
    selectedSkills = [];
    renderCtxChips();
    clearPrompt();
  }

  function dispatchPrompt(prompt) {
    prompt=prompt.trim();if(!prompt) return;
    var m;
    if((m=prompt.match(/^\/goal(?:\s+([\s\S]+))?$/i))){openGoalEditor(m[1]||'');clearPrompt();return;}
    if(/^\/skills$/i.test(prompt)){clearPrompt();openSkillsPanel();return;}
    if((m=prompt.match(/^\/handoff\s+(\S+)/i))){var t=m[1].toLowerCase();if(AGENT_IDS.indexOf(t)>=0){vscode.postMessage({type:'handoff',targetAgent:t});clearPrompt();return;}}
    if((m=prompt.match(/^\/agent\s+(\S+)/i))){var a=m[1].toLowerCase();if(AGENT_IDS.indexOf(a)>=0){vscode.postMessage({type:'setAgent',agent:a});clearPrompt();return;}}
    if((m=prompt.match(/^\/route\s+(\S+)/i))){var r=m[1].toLowerCase();if(r==='direct'||r==='proxy'){vscode.postMessage({type:'setRoute',route:r});clearPrompt();return;}}
    if((m=prompt.match(/^\/(review|implement|debug|explain|test)$/i))){var tid=m[1].toLowerCase();if(TPLS[tid]){els.prompt.value=TPLS[tid];autoGrow();els.prompt.focus();}return;}
    reallyDispatch(prompt);
  }

  function enqueueMessage(text) { messageQueue.push({ text: text }); renderQueue(); }

  function steerNow() {
    var text = els.prompt.value.trim(); if (!text) return;
    messageQueue.unshift({ text: text }); renderQueue(); clearPrompt();
    if (state && state.isRunning) { vscode.postMessage({ type: 'stop' }); } else { sendNextQueued(); }
  }

  function clearPrompt() { els.prompt.value='';els.costEstimate.textContent='';autoGrow(); }

  // Listeners
  els.send.addEventListener('click',function(){if(state&&state.isRunning) vscode.postMessage({type:'stop'});else dispatchPrompt(els.prompt.value);});
  els.goalBtn.addEventListener('click', function () { openGoalEditor(''); });
  els.goalCancel.addEventListener('click', closeGoalEditor);
  els.goalSave.addEventListener('click', function () { saveGoal(false); });
  els.goalStart.addEventListener('click', function () { saveGoal(true); });
  els.skillsBtn.addEventListener('click', openSkillsPanel);
  els.skillsClose.addEventListener('click', closeSkillsPanel);
  els.skillsSearch.addEventListener('input', renderSkillsList);
  els.planToggle.addEventListener('click',function(){togglePlanMode();if(planMode&&planSteps.length===0) addPlanStep();});
  els.compareToggle.addEventListener('click', toggleCompareMode);
  els.addStep.addEventListener('click',addPlanStep);
  els.runPlan.addEventListener('click',executePlan);
  if(els.saveTemplateBtn) els.saveTemplateBtn.addEventListener('click',saveAsTemplate);
  els.modeChip.addEventListener('click', openModeMenu);
  els.agentChip.addEventListener('click', openAgentMenu);
  els.atBtn.addEventListener('click', openAtMenu);
  els.attachBtn.addEventListener('click', function () { els.imageFileInput.click(); });
  els.imageFileInput.addEventListener('change', function () {
    var file = els.imageFileInput.files && els.imageFileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { vscode.postMessage({ type: 'attachImage', dataUrl: reader.result, name: file.name }); };
    reader.readAsDataURL(file);
    els.imageFileInput.value = '';
  });
  els.prompt.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        var file = items[i].getAsFile(); if (!file) continue;
        e.preventDefault();
        var reader = new FileReader();
        reader.onload = function () { vscode.postMessage({ type: 'attachImage', dataUrl: reader.result, name: file.name || 'pasted-image.png' }); };
        reader.readAsDataURL(file);
        break;
      }
    }
  });
  els.prompt.addEventListener('keydown',function(e){
    if(e.key==='Escape'){ closeGoalEditor(); closeSkillsPanel(); return; }
    if(e.key==='Enter' && (e.ctrlKey||e.metaKey) && e.shiftKey){ e.preventDefault(); steerNow(); return; }
    if(e.key==='Tab' && e.shiftKey){
      e.preventDefault();
      var ids=MODES.filter(function(m){return m.id!=='custom';}).map(function(m){return m.id;});
      var idx=ids.indexOf(currentAutonomy());
      var next=ids[(idx===-1?0:idx+1)%ids.length];
      vscode.postMessage({type:'setAutonomy',autonomy:next});
      return;
    }
    if(e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      var text=els.prompt.value.trim(); if(!text) return;
      if(state&&state.isRunning){ enqueueMessage(text); clearPrompt(); } else { dispatchPrompt(text); }
    }
  });
  var estTimer=null;els.prompt.addEventListener('input',function(){autoGrow();var value=els.prompt.value;if(!value){closeMenu();}else if(value.trim().charAt(0)==='/'){openCommandPicker();if(!/^\/([a-z]*)$/.test(value.trim().toLowerCase()))closeMenu();}else if(/\$[A-Za-z0-9_-]*$/.test(value)){openSkillPicker();}else{closeMenu();}clearTimeout(estTimer);estTimer=setTimeout(function(){var p=els.prompt.value.trim();if(p.length>10&&p.charAt(0)!=='/'){vscode.postMessage({type:'estimateCost',prompt:p,agent:currentAgent(),route:currentRoute()});}else{els.costEstimate.textContent='';}},400);});
  document.getElementById('newChat').addEventListener('click',function(){if(state&&state.isRunning) vscode.postMessage({type:'stop'});vscode.postMessage({type:'newConversation'});clearChat();els.prompt.focus();});
  els.historyClose.addEventListener('click', closeHistory);
  var historySearchTimer = null;
  els.historySearch.addEventListener('input', function () {
    clearTimeout(historySearchTimer);
    var q = els.historySearch.value;
    historySearchTimer = setTimeout(function () { vscode.postMessage({ type: 'searchConversations', query: q }); }, 250);
  });
  var openTabBtn=document.getElementById('openTab');if(openTabBtn) openTabBtn.addEventListener('click',function(){vscode.postMessage({type:'openTab'});});
  if(els.planTemplate) els.planTemplate.addEventListener('change',function(){var v=els.planTemplate.value;if(!v) return; vscode.postMessage({type:'loadTemplate',value:v});els.planTemplate.value='';});

  var showDetails=false;els.chat.classList.add('hide-telemetry');
  function toggleDetails(){showDetails=!showDetails;els.chat.classList.toggle('hide-telemetry',!showDetails);if(showDetails) scrollBottom(true);}

  // Everything that isn't chat lives behind the gear, so the header stays two
  // controls wide no matter how many panels we add later.
  var gearBtn=document.getElementById('gearBtn');
  if(gearBtn) gearBtn.addEventListener('click',function(){
    openMenuRich(gearBtn,[
      {label:'History',desc:'Past conversations',onClick:openHistory},
      {label:'Open as editor tab',desc:'Maximize or split',onClick:function(){vscode.postMessage({type:'openTab'});}},
      {label:'Details',desc:'Agent activity log',onClick:toggleDetails},
      {label:'Settings',desc:'Agents, keys, proxy',onClick:function(){vscode.postMessage({type:'openView',view:'settings'});}},
      {label:'Engine Room',desc:'Status and backups',onClick:function(){vscode.postMessage({type:'openView',view:'engineRoom'});}},
      {label:'Memory',desc:'Cognitive1 brain',onClick:function(){vscode.postMessage({type:'openView',view:'memory'});}},
      {label:'Sessions',desc:'History and cost',onClick:function(){vscode.postMessage({type:'openView',view:'sessions'});}}
    ]);
  });
  els.chat.addEventListener('click',function(e){
    var ap=e.target.closest('[data-approve]');var rj=e.target.closest('[data-reject]');
    if(ap){vscode.postMessage({type:'approveDiff',eventId:ap.getAttribute('data-approve')});return;}
    if(rj){vscode.postMessage({type:'rejectDiff',eventId:rj.getAttribute('data-reject')});return;}

    var link=e.target.closest('[data-kai-link]');
    if(link){e.preventDefault();vscode.postMessage({type:'openLink',url:link.getAttribute('data-kai-link')});return;}

    var copyEl=e.target.closest('[data-copy-text]');
    if(copyEl){
      copyToClipboard(copyEl.getAttribute('data-copy-text'));
      var original=copyEl.textContent;copyEl.textContent='Copied';copyEl.classList.add('copied');
      setTimeout(function(){copyEl.textContent=original;copyEl.classList.remove('copied');},1200);
    }
  });

  // Messages from extension
  window.addEventListener('message',function(e){
    var m=e.data;
    if(m.type==='state'){renderState(m.state);renderGoal(m.goal);if(m.plan!=null){currentPlan=m.plan;renderPlanProgress(m.plan);}}
    else if(m.type==='event') appendEvent(m.event);
    else if(m.type==='planEvent') handlePlanEvent(m.planEvent);
    else if(m.type==='capabilities') applyCapabilities(m.capabilities);
    else if(m.type==='turnMeta') pendingTurnMeta[m.taskId]={agent:m.agent,route:m.route,modelName:m.modelName};
    else if(m.type==='templates'){if(els.planTemplate){els.planTemplate.innerHTML='<option value="">Load template...</option>';for(var i=0;i<m.templates.length;i++){var t=m.templates[i];els.planTemplate.innerHTML+='<option value="'+esc(JSON.stringify(t))+'">'+esc(t.name)+'</option>';}}}
    else if(m.type==='templateLoaded'&&m.plan) loadTemplateIntoScreen(m.plan);
    else if(m.type==='costEstimate'){var est=m.estimate;els.costEstimate.textContent=est.modelName+': ~'+est.estimatedInputTokens.toLocaleString()+' in / ~'+est.estimatedOutputTokens.toLocaleString()+' out = $'+est.estimatedCostUsd.toFixed(est.estimatedCostUsd<0.01?4:2);}
    else if(m.type==='activeFile'){
      if(m.path){ activeFile = activeFile && activeFile.path===m.path ? activeFile : { path: m.path, included: activeFile ? activeFile.included : true }; }
      else { activeFile = null; }
      renderCtxChips();
    }
    else if(m.type==='addSelection'){ addContextChip({ type:'selection', path:m.path, startLine:m.startLine, endLine:m.endLine }); }
    else if(m.type==='searchFilesResult'){ renderAtResults(m.files||[]); }
    else if(m.type==='selectionResult'){
      if(m.none){ void 0; /* no selection — silently ignore, nothing to add */ }
      else { addContextChip({ type:'selection', path:m.path, startLine:m.startLine, endLine:m.endLine }); }
    }
    else if(m.type==='gitDiffStatResult'){ if(m.stat) addContextChip({ type:'gitDiff', stat:m.stat }); }
    else if(m.type==='memorySearchResult'){ addContextChip({ type:'memory', query:m.query, summary:m.summary }); }
    else if(m.type==='attachImageResult'){ if(m.ok) addContextChip({ type:'image', name:m.name, path:m.path }); }
    else if(m.type==='conversationsList'){ renderHistoryList(m.conversations); }
    else if(m.type==='conversationLoaded'){ replayConversation(m.conversation); }
    else if(m.type==='skills'){ setSkills(m.skills || []); }
    else if(m.type==='openGoal'){ openGoalEditor(''); }
    else if(m.type==='openSkills'){ openSkillsPanel(); }
  });

  if(state) renderState(state); else { renderModeChip(); renderAgentChip(); }
  if(currentPlan) renderPlanProgress(currentPlan);
  renderGoal(currentGoal);
  renderCtxChips(); renderQueue();
  autoGrow();
  vscode.postMessage({type:'ready'});
  vscode.postMessage({type:'listSkills'});
  vscode.postMessage({type:'loadTemplates'});
})();
