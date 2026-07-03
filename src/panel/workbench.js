/* KAI Agent Workbench — Chat UI Script */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var AGENT_IDS = window.__KAI_AGENT_IDS__ || ['claude', 'codex', 'qwen', 'gemini'];
  var state = window.__KAI_INITIAL_STATE__ || null;
  var totalCost = 0;
  var totalInput = 0;
  var totalOutput = 0;
  var currentAssistant = null; // active streaming assistant bubble

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
  };

  var emptyState = document.getElementById('emptyState');

  // ---- Helpers ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString(); } catch (e) { return ''; }
  }
  function nearBottom() {
    return els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 120;
  }
  function scrollBottom(force) {
    if (force || nearBottom()) els.chat.scrollTop = els.chat.scrollHeight;
  }
  function removeEmpty() {
    if (emptyState) emptyState.style.display = 'none';
  }
  function clearChat() {
    finalizeAssistant();
    Array.prototype.slice.call(els.chat.children).forEach(function (k) {
      if (k !== emptyState) k.remove();
    });
    if (emptyState) emptyState.style.display = '';
    totalCost = 0; totalInput = 0; totalOutput = 0;
    els.costPill.innerHTML = '';
    clearPrompt();
  }
  function autoGrow() {
    els.prompt.style.height = 'auto';
    els.prompt.style.height = Math.min(els.prompt.scrollHeight, 180) + 'px';
  }

  // ---- Chat messages ----
  function appendUserMessage(text) {
    removeEmpty();
    finalizeAssistant();
    var el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = '<span class="role">You</span>';
    el.appendChild(document.createTextNode(text));
    els.chat.appendChild(el);
    scrollBottom(true);
  }

  function finalizeAssistant() {
    if (currentAssistant) {
      currentAssistant.classList.remove('streaming');
      currentAssistant = null;
    }
  }

  function appendAssistantText(text, agent) {
    removeEmpty();
    if (!currentAssistant) {
      currentAssistant = document.createElement('div');
      currentAssistant.className = 'msg assistant streaming';
      var role = document.createElement('span');
      role.className = 'role';
      role.textContent = agent || (state && state.activeAgent) || 'Assistant';
      currentAssistant.appendChild(role);
      currentAssistant.appendChild(document.createTextNode(''));
      els.chat.appendChild(currentAssistant);
    }
    // Append to the trailing text node
    var last = currentAssistant.lastChild;
    if (last && last.nodeType === 3) last.nodeValue += text;
    else currentAssistant.appendChild(document.createTextNode(text));
    scrollBottom();
  }

  // ---- Activity cards (tools, diffs, approvals, errors…) ----
  function cardClass(e) {
    switch (e.type) {
      case 'tool.call': return 'tool';
      case 'diff.proposal':
      case 'file.edit.applied': return 'diff';
      case 'approval.request': return 'approval';
      case 'error': return 'error';
      case 'cost.update': return 'cost';
      case 'memory.event': return 'memory';
      case 'agent.lifecycle':
      case 'autonomy.changed':
      case 'route.changed': return 'lifecycle';
      default: return 'raw';
    }
  }
  function eventLabel(e) {
    var L = {
      'tool.call': 'Tool Call', 'diff.proposal': 'Diff', 'file.edit.applied': 'Edit Applied',
      'approval.request': 'Approval', 'error': 'Error', 'cost.update': 'Cost',
      'memory.event': 'Memory', 'agent.lifecycle': 'Lifecycle', 'autonomy.changed': 'Autonomy',
      'route.changed': 'Route', 'permission.escalation': 'Permission', 'raw.fallback': 'Raw',
    };
    return L[e.type] || e.type;
  }

  // Low-signal event types collapse into the muted, hidden-by-default log.
  var TELEMETRY = {
    'agent.lifecycle': 1, 'autonomy.changed': 1, 'route.changed': 1,
    'cost.update': 1, 'memory.event': 1, 'raw.fallback': 1,
  };
  function isTelemetry(type) { return !!TELEMETRY[type]; }

  function accumulateCost(event) {
    if (event.inputTokens) totalInput += event.inputTokens;
    if (event.outputTokens) totalOutput += event.outputTokens;
    if (event.amountUsd != null) totalCost = event.amountUsd;
    renderState(state);
  }

  function telemetryText(event) {
    switch (event.type) {
      case 'cost.update':
        return [
          event.inputTokens != null ? 'In ' + event.inputTokens : '',
          event.outputTokens != null ? 'Out ' + event.outputTokens : '',
          event.amountUsd != null ? '$' + event.amountUsd.toFixed(4) : '',
        ].filter(Boolean).join(' · ');
      case 'memory.event':
        return (event.action ? event.action + ': ' : '') + (event.summary || '');
      case 'raw.fallback':
        var p = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload);
        return p.length > 240 ? p.slice(0, 240) + '…' : p;
      default:
        return event.detail || event.summary || event.message || '';
    }
  }

  function renderTelemetry(event) {
    var row = document.createElement('div');
    row.className = 'log-row telemetry';
    var tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = eventLabel(event) + (event.agent ? ' · ' + event.agent : '');
    row.appendChild(tag);
    row.appendChild(document.createTextNode(telemetryText(event)));
    return row;
  }

  function renderCard(event) {
    var card = document.createElement('div');
    card.className = 'event-card ' + cardClass(event);

    var hdr = document.createElement('div');
    hdr.className = 'event-header';
    hdr.innerHTML =
      '<span class="event-source">' + eventLabel(event) +
      (event.agent ? ' · ' + esc(event.agent) : '') + '</span><span>' + fmtTime(event.timestamp) + '</span>';
    card.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'event-body';

    switch (event.type) {
      case 'tool.call':
        body.innerHTML = '<span class="tool-name">' + esc(event.name) +
          '</span> <span class="tool-status">' + esc(event.status) + '</span>';
        if (event.input) {
          var pre = document.createElement('div');
          pre.className = 'diff-preview';
          pre.textContent = JSON.stringify(event.input, null, 2);
          body.appendChild(pre);
        }
        break;

      case 'diff.proposal':
        body.innerHTML = '<div class="diff-summary">' + esc(event.filePath) +
          '</div><div>' + esc(event.summary) + '</div>';
        if (event.diff) {
          var dp = document.createElement('div');
          dp.className = 'diff-preview';
          dp.textContent = event.diff;
          body.appendChild(dp);
        }
        var actions = document.createElement('div');
        actions.className = 'approval-actions';
        actions.innerHTML =
          '<button data-approve="' + esc(event.id) + '">Approve</button>' +
          '<button class="secondary" data-reject="' + esc(event.id) + '">Reject</button>';
        body.appendChild(actions);
        break;

      case 'file.edit.applied':
        body.innerHTML = '<div class="diff-summary">' + esc(event.filePath) +
          '</div><div>' + esc(event.summary) + '</div>';
        break;

      case 'approval.request':
        body.innerHTML = '<strong>' + esc(event.title) + '</strong> <span class="risk-' +
          esc(event.risk) + '">[' + esc(event.risk) + ' risk]</span><div>' + esc(event.detail) + '</div>';
        break;

      case 'error':
        body.textContent = event.message;
        break;

      case 'cost.update':
        if (event.inputTokens) totalInput += event.inputTokens;
        if (event.outputTokens) totalOutput += event.outputTokens;
        if (event.amountUsd != null) totalCost = event.amountUsd;
        body.innerHTML = '<div class="cost-detail">' +
          (event.inputTokens != null ? 'In: ' + event.inputTokens + ' tk' : '') +
          (event.outputTokens != null ? ' | Out: ' + event.outputTokens + ' tk' : '') +
          (event.amountUsd != null ? ' | $' + event.amountUsd.toFixed(4) : '') + '</div>';
        renderState(state);
        break;

      case 'memory.event':
        body.innerHTML = '<span class="memory-action">' + esc(event.action) +
          '</span><div>' + esc(event.summary) + '</div>';
        break;

      case 'agent.lifecycle':
      case 'autonomy.changed':
      case 'route.changed':
      case 'permission.escalation':
        body.textContent = event.detail || event.summary || event.message || '';
        break;

      case 'raw.fallback':
        body.textContent = typeof event.payload === 'string'
          ? event.payload : JSON.stringify(event.payload, null, 2);
        break;

      default:
        body.textContent = event.summary || event.message || event.detail || JSON.stringify(event);
    }

    card.appendChild(body);
    return card;
  }

  function appendEvent(event) {
    if (event.type === 'text.delta') {
      appendAssistantText(event.text, event.agent);
      return;
    }
    if (event.type === 'cost.update') accumulateCost(event);

    removeEmpty();
    finalizeAssistant();
    if (isTelemetry(event.type)) {
      els.chat.appendChild(renderTelemetry(event));
    } else {
      els.chat.appendChild(renderCard(event));
    }
    scrollBottom();
  }

  // ---- State ----
  function renderState(next) {
    state = next;
    els.agent.value = state.activeAgent;
    els.route.value = state.route;
    els.autonomy.value = state.autonomy;

    var running = state.isRunning;
    els.agent.disabled = running;
    els.route.disabled = running;
    els.autonomy.disabled = running;

    if (running) {
      els.send.textContent = 'Stop';
      els.send.classList.add('stop');
    } else {
      els.send.textContent = 'Send';
      els.send.classList.remove('stop');
      finalizeAssistant();
    }

    els.statePill.innerHTML = running
      ? '<span class="pill running"><span class="dot"></span>running</span>'
      : '<span class="pill"><span class="dot"></span>idle</span>';

    if (totalCost > 0) {
      els.costPill.innerHTML = '<span class="pill cost">$' + totalCost.toFixed(4) +
        ' · ' + totalInput + ' in / ' + totalOutput + ' out</span>';
    }
  }

  // ---- Prompt dispatch ----
  function dispatchPrompt(prompt) {
    prompt = prompt.trim();
    if (!prompt) return;

    var m;
    if ((m = prompt.match(/^\/handoff\s+(\S+)/i))) {
      var t = m[1].toLowerCase();
      if (AGENT_IDS.indexOf(t) >= 0) {
        vscode.postMessage({ type: 'handoff', targetAgent: t });
        clearPrompt();
        return;
      }
    }
    if ((m = prompt.match(/^\/agent\s+(\S+)/i))) {
      var a = m[1].toLowerCase();
      if (AGENT_IDS.indexOf(a) >= 0) {
        vscode.postMessage({ type: 'setAgent', agent: a });
        clearPrompt();
        return;
      }
    }
    if ((m = prompt.match(/^\/route\s+(\S+)/i))) {
      var r = m[1].toLowerCase();
      if (r === 'direct' || r === 'proxy') {
        vscode.postMessage({ type: 'setRoute', route: r });
        clearPrompt();
        return;
      }
    }
    if ((m = prompt.match(/^\/(review|implement|debug|explain|test)$/i))) {
      var tid = m[1].toLowerCase();
      if (TPLS[tid]) { els.prompt.value = TPLS[tid]; autoGrow(); els.prompt.focus(); }
      return;
    }

    // Real task → show user bubble, then run
    appendUserMessage(prompt);
    vscode.postMessage({
      type: 'startTask',
      prompt: prompt,
      agent: els.agent.value,
      route: els.route.value,
      autonomy: els.autonomy.value,
    });
    clearPrompt();
  }

  function clearPrompt() {
    els.prompt.value = '';
    els.costEstimate.textContent = '';
    autoGrow();
  }

  // ---- Listeners ----
  document.querySelectorAll('#templates button').forEach(function (b) {
    b.addEventListener('click', function () {
      els.prompt.value = TPLS[this.getAttribute('data-tpl')];
      autoGrow();
      els.prompt.focus();
    });
  });

  els.agent.addEventListener('change', function () {
    vscode.postMessage({ type: 'setAgent', agent: els.agent.value });
  });
  els.route.addEventListener('change', function () {
    vscode.postMessage({ type: 'setRoute', route: els.route.value });
  });
  els.autonomy.addEventListener('change', function () {
    vscode.postMessage({ type: 'setAutonomy', autonomy: els.autonomy.value });
  });

  els.send.addEventListener('click', function () {
    if (state && state.isRunning) vscode.postMessage({ type: 'stop' });
    else dispatchPrompt(els.prompt.value);
  });

  els.prompt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!(state && state.isRunning)) dispatchPrompt(els.prompt.value);
    }
  });

  var estTimer = null;
  els.prompt.addEventListener('input', function () {
    autoGrow();
    clearTimeout(estTimer);
    estTimer = setTimeout(function () {
      var p = els.prompt.value.trim();
      if (p.length > 10 && p.charAt(0) !== '/') {
        vscode.postMessage({ type: 'estimateCost', prompt: p, agent: els.agent.value, route: els.route.value });
      } else {
        els.costEstimate.textContent = '';
      }
    }, 400);
  });

  // New chat — clears this window's transcript (each window is independent)
  document.getElementById('newChat').addEventListener('click', function () {
    if (state && state.isRunning) vscode.postMessage({ type: 'stop' });
    clearChat();
    els.prompt.focus();
  });

  // Details toggle — reveal/hide the muted telemetry log
  var showDetails = false;
  els.chat.classList.add('hide-telemetry');
  var detailsToggle = document.getElementById('detailsToggle');
  detailsToggle.addEventListener('click', function () {
    showDetails = !showDetails;
    els.chat.classList.toggle('hide-telemetry', !showDetails);
    detailsToggle.classList.toggle('active', showDetails);
    detailsToggle.textContent = showDetails ? 'Hide log' : 'Details';
    if (showDetails) scrollBottom(true);
  });

  // Delegated approve / reject buttons on diff cards
  els.chat.addEventListener('click', function (e) {
    var ap = e.target.closest('[data-approve]');
    var rj = e.target.closest('[data-reject]');
    if (ap) vscode.postMessage({ type: 'approveDiff', eventId: ap.getAttribute('data-approve') });
    else if (rj) vscode.postMessage({ type: 'rejectDiff', eventId: rj.getAttribute('data-reject') });
  });

  // ---- Messages from extension ----
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'state') renderState(m.state);
    else if (m.type === 'event') appendEvent(m.event);
    else if (m.type === 'costEstimate') {
      var est = m.estimate;
      els.costEstimate.textContent = est.modelName + ': ~' +
        est.estimatedInputTokens.toLocaleString() + ' in / ~' +
        est.estimatedOutputTokens.toLocaleString() + ' out ≈ $' +
        est.estimatedCostUsd.toFixed(est.estimatedCostUsd < 0.01 ? 4 : 2);
    }
  });

  // ---- Init ----
  if (state) renderState(state);
  autoGrow();
  vscode.postMessage({ type: 'ready' });
})();
