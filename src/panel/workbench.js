/* KAI Agent Workbench — Chat UI Script */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var AGENT_IDS = window.__KAI_AGENT_IDS__ || ['claude', 'codex', 'qwen', 'gemini'];
  var AGENT_NAMES = window.__KAI_AGENT_NAMES__ || {};
  var state = window.__KAI_INITIAL_STATE__ || null;
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

  var els = {
    agent: document.getElementById('agent'),
    route: document.getElementById('route'),
    autonomy: document.getElementById('autonomy'),
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
    totalCost=0;totalInput=0;totalOutput=0; els.costPill.innerHTML='';
    for (var id in turns) { if (turns[id].timerInterval) clearInterval(turns[id].timerInterval); }
    turns = {};
    clearPrompt();
  }
  function autoGrow() { els.prompt.style.height='auto'; els.prompt.style.height=Math.min(els.prompt.scrollHeight,180)+'px'; }
  function agentLabel(agent) { return AGENT_NAMES[agent] || (agent ? agent.charAt(0).toUpperCase()+agent.slice(1) : 'Assistant'); }

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
  function togglePlanMode() { planMode=!planMode; els.planEditor.style.display=planMode?'block':'none'; els.planToggle.classList.toggle('active',planMode); els.planToggle.title=planMode?'Exit plan mode':'Plan mode'; }
  function addPlanStep() { planSteps.push({agent:els.agent.value,prompt:''}); renderPlanSteps(); }
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
    var plan={id:'plan_'+Date.now(),title:els.planTitle.value.trim()||'Untitled Plan',steps:planSteps.map(function(s,i){return{id:'step_'+i,agent:s.agent,prompt:s.prompt.trim(),status:'pending'};}),route:els.route.value,autonomy:els.autonomy.value,status:'ready',currentStepIndex:0,createdAt:new Date().toISOString()};
    removeEmpty(); appendUserMessage('Plan: '+plan.title+' ('+plan.steps.length+' steps)'); vscode.postMessage({type:'executePlan',value:JSON.stringify(plan)});
    togglePlanMode(); planSteps=[]; els.planTitle.value=''; renderPlanSteps();
  }

  function saveAsTemplate() {
    if(planSteps.length===0) return;
    var name = els.planTitle.value.trim()||'My Plan';
    var template={name:name,description:'',steps:planSteps.map(function(s){return{agent:s.agent,prompt:s.prompt};}),route:els.route.value,autonomy:els.autonomy.value};
    vscode.postMessage({type:'saveTemplate',value:JSON.stringify(template)});
  }

  function loadTemplateIntoScreen(template) {
    els.planTitle.value = template.name||'';
    planSteps = template.steps.map(function(s){return{agent:s.agent,prompt:s.prompt};});
    renderPlanSteps();
    if(!planMode) togglePlanMode();
  }

  function renderPlanProgress(plan) {
    if(!plan){ els.planProgress.style.display='none'; return; }
    els.planProgress.style.display='block';
    var h='<div class="pp-header"><span class="pp-title">'+esc(plan.title)+'</span><span class="pp-status status-'+plan.status+'">'+plan.status+'</span></div>';
    h+='<div class="pp-controls">';
    if(plan.status==='running'){ h+='<button id="pausePlanBtn" class="plan-ctrl-btn">Pause</button><button id="abortPlanBtn" class="plan-ctrl-btn abort">Abort</button>'; }
    else if(plan.status==='paused'){ h+='<button id="resumePlanBtn" class="plan-ctrl-btn">Resume</button><button id="abortPlanBtn" class="plan-ctrl-btn abort">Abort</button>'; }
    h+='</div><div class="pp-steps">';
    for(var i=0;i<plan.steps.length;i++){
      var st=plan.steps[i], icon=st.status==='completed'?'V':st.status==='running'?'O':st.status==='failed'?'X':st.status==='skipped'?'-':'o';
      h+='<div class="pp-step pp-'+st.status+'"><span class="pp-step-icon">'+icon+'</span><span class="pp-step-agent">'+esc(st.agent)+'</span><span class="pp-step-label">'+esc(st.label||st.prompt.slice(0,60))+'</span>';
      if(st.status==='failed'&&plan.status==='paused'){
        h+='<button class="pp-retry-btn" data-step-id="'+esc(st.id)+'">Retry</button><button class="pp-skip-btn" data-step-id="'+esc(st.id)+'">Skip</button>';
      }
      if(st.error) h+='<span class="pp-step-error">'+esc(st.error)+'</span>';
      h+='</div>';
    }
    h+='</div>';
    els.planProgress.innerHTML=h;

    var pb=document.getElementById('pausePlanBtn'),rb=document.getElementById('resumePlanBtn'),ab=document.getElementById('abortPlanBtn');
    if(pb) pb.addEventListener('click',function(){vscode.postMessage({type:'pausePlan'});});
    if(rb) rb.addEventListener('click',function(){vscode.postMessage({type:'resumePlan'});});
    if(ab) ab.addEventListener('click',function(){vscode.postMessage({type:'abortPlan'});});

    els.planProgress.querySelectorAll('.pp-retry-btn').forEach(function(btn){
      btn.addEventListener('click',function(){
        var sid=btn.getAttribute('data-step-id');
        var newPrompt=prompt('Edit prompt for retry (leave blank to keep original):');
        vscode.postMessage({type:'retryStep',eventId:sid,value:newPrompt||undefined});
      });
    });
    els.planProgress.querySelectorAll('.pp-skip-btn').forEach(function(btn){
      btn.addEventListener('click',function(){ vscode.postMessage({type:'skipStep',eventId:btn.getAttribute('data-step-id')}); });
    });
  }

  function handlePlanEvent(planEvent) {
    switch(planEvent.type){
      case 'plan.started': els.planProgress.style.display='block'; els.planProgress.innerHTML='<div class="pp-header">Plan started...</div>'; break;
      case 'plan.step.paused_for_retry': break;
      case 'plan.completed': case 'plan.aborted': renderPlanProgress(null); break;
      default: break;
    }
  }

  // ---- User messages ----
  function pinThinking() { if(thinkingEl&&els.chat.lastChild!==thinkingEl) els.chat.appendChild(thinkingEl); }
  function appendUserMessage(text) { removeEmpty(); finalizeAssistant(); var el=document.createElement('div'); el.className='msg user'; el.innerHTML='<span class="role">You</span>'; el.appendChild(document.createTextNode(text)); els.chat.appendChild(el); startThinking(); scrollBottom(true); }
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
      vscode.postMessage({ type: 'startTask', prompt: lastUserPrompt, agent: turn.agent, route: els.route.value, autonomy: els.autonomy.value });
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

  function appendEvent(event) {
    if(event.compareId){
      if(!activeCompare) activeCompare={left:event.side==='left'?event.agent:'',right:event.side==='right'?event.agent:''};
      if(!document.getElementById('compare-panes')){
        var panes=document.createElement('div');panes.id='compare-panes';
        panes.innerHTML='<div class="compare-pane left" id="cp-left"><div class="compare-label">'+esc(activeCompare.left||'Left')+'</div></div><div class="compare-pane right" id="cp-right"><div class="compare-label">'+esc(activeCompare.right||'Right')+'</div></div>';
        els.chat.appendChild(panes); removeEmpty();
      }
      var tp=document.getElementById(event.side==='left'?'cp-left':'cp-right'); if(!tp) return;
      if(event.type==='text.delta'){ var t=document.createElement('span');t.className='cmp-text';t.textContent=event.text; tp.appendChild(t); }
      else if(event.type==='raw.fallback'&&event.sourceType==='compare.complete' && typeof renderCompareSummary==='function'){ renderCompareSummary(event.payload); }
      else if(event.type==='cost.update') accumulateCost(event);
      scrollBottom(true); return;
    }

    var detail = activityDetail(event);
    if (detail) setThinkingDetail(detail);

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
      if (event.type === 'diff.proposal' || event.type === 'file.edit.applied' || event.type === 'approval.request' || event.type === 'error') {
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

  function renderState(next) {
    state=next;
    els.agent.value=state.activeAgent;els.route.value=state.route;els.autonomy.value=state.autonomy;
    var running=state.isRunning;
    els.agent.disabled=running;els.route.disabled=running;els.autonomy.disabled=running;els.planToggle.disabled=running;
    if(running){els.send.textContent='Stop';els.send.classList.add('stop');startThinking();}else{els.send.textContent='Send';els.send.classList.remove('stop');finalizeAssistant();stopThinking();}
    els.statePill.innerHTML=running?'<span class="pill running"><span class="dot"></span>running</span>':'<span class="pill"><span class="dot"></span>idle</span>';
    if(totalCost>0) els.costPill.innerHTML='<span class="pill cost">$'+totalCost.toFixed(4)+' . '+totalInput+' in / '+totalOutput+' out</span>';
  }

  function applyCapabilities(capabilities) {
    capabilitiesById = {};
    (capabilities || []).forEach(function (c) { capabilitiesById[c.id] = c; });
    Array.prototype.forEach.call(els.agent.options, function (opt) {
      var cap = capabilitiesById[opt.value];
      var unavailable = cap && cap.available === false;
      opt.disabled = !!unavailable;
      opt.title = unavailable ? (cap.unavailableReason || 'Unavailable') : '';
      opt.textContent = agentLabel(opt.value) + (unavailable ? ' (unavailable)' : '');
    });
  }

  function dispatchPrompt(prompt) {
    prompt=prompt.trim();if(!prompt) return;
    var m;
    if((m=prompt.match(/^\/handoff\s+(\S+)/i))){var t=m[1].toLowerCase();if(AGENT_IDS.indexOf(t)>=0){vscode.postMessage({type:'handoff',targetAgent:t});clearPrompt();return;}}
    if((m=prompt.match(/^\/agent\s+(\S+)/i))){var a=m[1].toLowerCase();if(AGENT_IDS.indexOf(a)>=0){vscode.postMessage({type:'setAgent',agent:a});clearPrompt();return;}}
    if((m=prompt.match(/^\/route\s+(\S+)/i))){var r=m[1].toLowerCase();if(r==='direct'||r==='proxy'){vscode.postMessage({type:'setRoute',route:r});clearPrompt();return;}}
    if((m=prompt.match(/^\/(review|implement|debug|explain|test)$/i))){var tid=m[1].toLowerCase();if(TPLS[tid]){els.prompt.value=TPLS[tid];autoGrow();els.prompt.focus();}return;}
    lastUserPrompt = prompt;
    appendUserMessage(prompt);vscode.postMessage({type:'startTask',prompt:prompt,agent:els.agent.value,route:els.route.value,autonomy:els.autonomy.value});clearPrompt();
  }

  function clearPrompt() { els.prompt.value='';els.costEstimate.textContent='';autoGrow(); }

  // Listeners
  document.querySelectorAll('#templates button').forEach(function(b){b.addEventListener('click',function(){els.prompt.value=TPLS[this.getAttribute('data-tpl')];autoGrow();els.prompt.focus();});});
  els.agent.addEventListener('change',function(){vscode.postMessage({type:'setAgent',agent:els.agent.value});});
  els.route.addEventListener('change',function(){vscode.postMessage({type:'setRoute',route:els.route.value});});
  els.autonomy.addEventListener('change',function(){vscode.postMessage({type:'setAutonomy',autonomy:els.autonomy.value});});
  els.send.addEventListener('click',function(){if(state&&state.isRunning) vscode.postMessage({type:'stop'});else dispatchPrompt(els.prompt.value);});
  els.planToggle.addEventListener('click',function(){togglePlanMode();if(planMode&&planSteps.length===0) addPlanStep();});
  els.addStep.addEventListener('click',addPlanStep);
  els.runPlan.addEventListener('click',executePlan);
  if(els.saveTemplateBtn) els.saveTemplateBtn.addEventListener('click',saveAsTemplate);
  els.prompt.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(!(state&&state.isRunning)) dispatchPrompt(els.prompt.value);}});
  var estTimer=null;els.prompt.addEventListener('input',function(){autoGrow();clearTimeout(estTimer);estTimer=setTimeout(function(){var p=els.prompt.value.trim();if(p.length>10&&p.charAt(0)!=='/'){vscode.postMessage({type:'estimateCost',prompt:p,agent:els.agent.value,route:els.route.value});}else{els.costEstimate.textContent='';}},400);});
  document.getElementById('newChat').addEventListener('click',function(){if(state&&state.isRunning) vscode.postMessage({type:'stop'});clearChat();els.prompt.focus();});
  var openTabBtn=document.getElementById('openTab');if(openTabBtn) openTabBtn.addEventListener('click',function(){vscode.postMessage({type:'openTab'});});
  if(els.planTemplate) els.planTemplate.addEventListener('change',function(){var v=els.planTemplate.value;if(!v) return; vscode.postMessage({type:'loadTemplate',value:v});els.planTemplate.value='';});

  var showDetails=false;els.chat.classList.add('hide-telemetry');
  var detailsToggle=document.getElementById('detailsToggle');detailsToggle.addEventListener('click',function(){showDetails=!showDetails;els.chat.classList.toggle('hide-telemetry',!showDetails);detailsToggle.classList.toggle('active',showDetails);detailsToggle.textContent=showDetails?'Hide log':'Details';if(showDetails) scrollBottom(true);});
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
    if(m.type==='state'){renderState(m.state);if(m.plan!=null){currentPlan=m.plan;renderPlanProgress(m.plan);}}
    else if(m.type==='event') appendEvent(m.event);
    else if(m.type==='planEvent') handlePlanEvent(m.planEvent);
    else if(m.type==='capabilities') applyCapabilities(m.capabilities);
    else if(m.type==='turnMeta') pendingTurnMeta[m.taskId]={agent:m.agent,route:m.route,modelName:m.modelName};
    else if(m.type==='templates'){if(els.planTemplate){els.planTemplate.innerHTML='<option value="">Load template...</option>';for(var i=0;i<m.templates.length;i++){var t=m.templates[i];els.planTemplate.innerHTML+='<option value="'+esc(JSON.stringify(t))+'">'+esc(t.name)+'</option>';}}}
    else if(m.type==='templateLoaded'&&m.plan) loadTemplateIntoScreen(m.plan);
    else if(m.type==='costEstimate'){var est=m.estimate;els.costEstimate.textContent=est.modelName+': ~'+est.estimatedInputTokens.toLocaleString()+' in / ~'+est.estimatedOutputTokens.toLocaleString()+' out = $'+est.estimatedCostUsd.toFixed(est.estimatedCostUsd<0.01?4:2);}
  });

  if(state) renderState(state);
  if(currentPlan) renderPlanProgress(currentPlan);
  autoGrow();
  vscode.postMessage({type:'ready'});
  vscode.postMessage({type:'loadTemplates'});
})();
