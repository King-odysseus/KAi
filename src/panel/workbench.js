/* KAI Agent Workbench — Chat UI Script */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var AGENT_IDS = window.__KAI_AGENT_IDS__ || ['claude', 'codex', 'qwen', 'gemini'];
  var state = window.__KAI_INITIAL_STATE__ || null;
  var totalCost = 0;
  var totalInput = 0;
  var totalOutput = 0;
  var currentAssistant = null;
  var planMode = false;
  var planSteps = [];
  var currentPlan = window.__KAI_INITIAL_PLAN__ || null;
  var activeCompare = null;

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
  function clearChat() { finalizeAssistant(); stopThinking(); Array.prototype.slice.call(els.chat.children).forEach(function(k){ if(k!==emptyState) k.remove(); }); if(emptyState) emptyState.style.display=''; totalCost=0;totalInput=0;totalOutput=0; els.costPill.innerHTML=''; clearPrompt(); }
  function autoGrow() { els.prompt.style.height='auto'; els.prompt.style.height=Math.min(els.prompt.scrollHeight,180)+'px'; }

  // Plan mode
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

  // Chat
  function pinThinking() { if(thinkingEl&&els.chat.lastChild!==thinkingEl) els.chat.appendChild(thinkingEl); }
  function appendUserMessage(text) { removeEmpty(); finalizeAssistant(); var el=document.createElement('div'); el.className='msg user'; el.innerHTML='<span class="role">You</span>'; el.appendChild(document.createTextNode(text)); els.chat.appendChild(el); startThinking(); scrollBottom(true); }
  function finalizeAssistant() { if(currentAssistant){currentAssistant.classList.remove('streaming');currentAssistant=null;} }
  function appendAssistantText(text,agent) { removeEmpty(); if(!currentAssistant){ currentAssistant=document.createElement('div');currentAssistant.className='msg assistant streaming';var role=document.createElement('span');role.className='role';role.textContent=agent||(state&&state.activeAgent)||'Assistant';currentAssistant.appendChild(role);currentAssistant.appendChild(document.createTextNode(''));els.chat.appendChild(currentAssistant); } var last=currentAssistant.lastChild; if(last&&last.nodeType===3) last.nodeValue+=text; else currentAssistant.appendChild(document.createTextNode(text)); pinThinking(); scrollBottom(); }

  function cardClass(e) { switch(e.type){case'tool.call':return'tool';case'diff.proposal':case'file.edit.applied':return'diff';case'approval.request':return'approval';case'error':return'error';case'cost.update':return'cost';case'memory.event':return'memory';case'agent.lifecycle':case'autonomy.changed':case'route.changed':return'lifecycle';default:return'raw';} }
  function eventLabel(e) { var L={'tool.call':'Tool Call','diff.proposal':'Diff','file.edit.applied':'Edit Applied','approval.request':'Approval','error':'Error','cost.update':'Cost','memory.event':'Memory','agent.lifecycle':'Lifecycle','autonomy.changed':'Autonomy','route.changed':'Route','permission.escalation':'Permission','raw.fallback':'Raw'}; return L[e.type]||e.type; }
  var TELEMETRY={'agent.lifecycle':1,'autonomy.changed':1,'route.changed':1,'cost.update':1,'memory.event':1,'raw.fallback':1};
  function isTelemetry(type) { return !!TELEMETRY[type]; }

  function accumulateCost(event) { if(event.inputTokens) totalInput+=event.inputTokens; if(event.outputTokens) totalOutput+=event.outputTokens; if(event.amountUsd!=null) totalCost=event.amountUsd; renderState(state); }
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
      case'cost.update':if(event.inputTokens) totalInput+=event.inputTokens;if(event.outputTokens) totalOutput+=event.outputTokens;if(event.amountUsd!=null) totalCost=event.amountUsd;body.innerHTML='<div class="cost-detail">'+(event.inputTokens!=null?'In: '+event.inputTokens+' tk':'')+(event.outputTokens!=null?' | Out: '+event.outputTokens+' tk':'')+(event.amountUsd!=null?' | $'+event.amountUsd.toFixed(4):'')+'</div>';renderState(state);break;
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
    if(event.type==='text.delta'){appendAssistantText(event.text,event.agent);return;} if(event.type==='cost.update') accumulateCost(event); var detail=activityDetail(event); if(detail) setThinkingDetail(detail); removeEmpty(); finalizeAssistant(); if(isTelemetry(event.type)){els.chat.appendChild(renderTelemetry(event));}else{els.chat.appendChild(renderCard(event));} pinThinking(); scrollBottom();
  }

  function renderState(next) {
    state=next;
    els.agent.value=state.activeAgent;els.route.value=state.route;els.autonomy.value=state.autonomy;
    var running=state.isRunning;
    els.agent.disabled=running;els.route.disabled=running;els.autonomy.disabled=running;els.planToggle.disabled=running;
    if(running){els.send.textContent='Stop';els.send.classList.add('stop');startThinking();}else{els.send.textContent='Send';els.send.classList.remove('stop');finalizeAssistant();stopThinking();}
    els.statePill.innerHTML=running?'<span class="pill running"><span class="dot"></span>running</span>':'<span class="pill"><span class="dot"></span>idle</span>';
    if(totalCost>0) els.costPill.innerHTML='<span class="pill cost">$'+totalCost.toFixed(4)+' . '+totalInput+' in / '+totalOutput+' out</span>';
  }

  function dispatchPrompt(prompt) {
    prompt=prompt.trim();if(!prompt) return;
    var m;
    if((m=prompt.match(/^\/handoff\s+(\S+)/i))){var t=m[1].toLowerCase();if(AGENT_IDS.indexOf(t)>=0){vscode.postMessage({type:'handoff',targetAgent:t});clearPrompt();return;}}
    if((m=prompt.match(/^\/agent\s+(\S+)/i))){var a=m[1].toLowerCase();if(AGENT_IDS.indexOf(a)>=0){vscode.postMessage({type:'setAgent',agent:a});clearPrompt();return;}}
    if((m=prompt.match(/^\/route\s+(\S+)/i))){var r=m[1].toLowerCase();if(r==='direct'||r==='proxy'){vscode.postMessage({type:'setRoute',route:r});clearPrompt();return;}}
    if((m=prompt.match(/^\/(review|implement|debug|explain|test)$/i))){var tid=m[1].toLowerCase();if(TPLS[tid]){els.prompt.value=TPLS[tid];autoGrow();els.prompt.focus();}return;}
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
  els.chat.addEventListener('click',function(e){var ap=e.target.closest('[data-approve]');var rj=e.target.closest('[data-reject]');if(ap) vscode.postMessage({type:'approveDiff',eventId:ap.getAttribute('data-approve')});else if(rj) vscode.postMessage({type:'rejectDiff',eventId:rj.getAttribute('data-reject')});});

  // Messages from extension
  window.addEventListener('message',function(e){
    var m=e.data;
    if(m.type==='state'){renderState(m.state);if(m.plan!=null){currentPlan=m.plan;renderPlanProgress(m.plan);}}
    else if(m.type==='event') appendEvent(m.event);
    else if(m.type==='planEvent') handlePlanEvent(m.planEvent);
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