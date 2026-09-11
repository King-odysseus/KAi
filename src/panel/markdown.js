/* KAI Agent Workbench — minimal markdown renderer for chat replies.
 *
 * Exposes window.kaiMarkdown(text) -> HTML string. HTML-escapes the raw
 * text first, then layers markup on top, so the only tags in the output
 * are the ones this file emits. Safe to use with innerHTML.
 *
 * Supports: fenced code blocks (with a language label + Copy button),
 * inline code, bold, italic, headings, bullet/numbered lists, paragraphs,
 * and http(s) links (rendered as <a data-kai-link="...">, opened by the
 * host page via vscode.env.openExternal — never a bare href, so the
 * webview's CSP default-src 'none' can't be used to navigate away).
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    return esc(s).replace(/'/g, '&#39;');
  }

  // Inline spans: code, bold, italic, links. Order matters — code first so
  // markup characters inside `code` are never re-processed.
  function inline(text) {
    var out = esc(text);
    out = out.replace(/`([^`]+)`/g, function (_, code) {
      return '<code>' + code + '</code>';
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/\b(https?:\/\/[^\s<>"]+)/g, function (_, url) {
      var clean = url.replace(/[.,;:!?)]+$/, '');
      var trail = url.slice(clean.length);
      return (
        '<a href="#" data-kai-link=\'' + escAttr(clean) + '\'>' + clean + '</a>' + trail
      );
    });
    return out;
  }

  var LANG_LABEL = {
    js: 'JavaScript', ts: 'TypeScript', tsx: 'TSX', jsx: 'JSX',
    py: 'Python', json: 'JSON', sh: 'Shell', bash: 'Shell',
    css: 'CSS', html: 'HTML', md: 'Markdown', yaml: 'YAML', yml: 'YAML',
  };

  function codeBlockHtml(lang, code) {
    var label = lang ? (LANG_LABEL[lang.toLowerCase()] || lang) : 'Code';
    // Strip exactly one trailing newline so the block doesn't show a blank line.
    var body = code.replace(/\n$/, '');
    return (
      '<div class="md-code">' +
      '<div class="md-code-head"><span>' + esc(label) + '</span>' +
      '<button type="button" class="md-copy" data-copy-text=\'' + escAttr(body) + '\'>Copy</button>' +
      '</div>' +
      '<pre><code>' + esc(body) + '</code></pre>' +
      '</div>'
    );
  }

  function renderBlocks(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
    var html = '';
    var i = 0;
    var para = [];
    var list = null; // { tag: 'ul'|'ol', items: [] }

    function flushPara() {
      if (para.length) {
        html += '<p>' + inline(para.join(' ')) + '</p>';
        para = [];
      }
    }
    function flushList() {
      if (list) {
        html += '<' + list.tag + '>' + list.items.map(function (it) {
          return '<li>' + inline(it) + '</li>';
        }).join('') + '</' + list.tag + '>';
        list = null;
      }
    }

    while (i < lines.length) {
      var line = lines[i];

      var fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        flushPara(); flushList();
        var lang = fence[1];
        var body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html += codeBlockHtml(lang, body.join('\n') + '\n');
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara(); flushList();
        html += '<p class="md-heading">' + inline(heading[2]) + '</p>';
        i++;
        continue;
      }

      var bullet = line.match(/^\s*[-*]\s+(.*)$/);
      var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushPara();
        var tag = bullet ? 'ul' : 'ol';
        var item = (bullet || numbered)[1];
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push(item);
        i++;
        continue;
      }

      if (line.trim() === '') {
        flushPara(); flushList();
        i++;
        continue;
      }

      flushList();
      para.push(line.trim());
      i++;
    }
    flushPara();
    flushList();
    return html;
  }

  window.kaiMarkdown = function (text) {
    return renderBlocks(text);
  };
})();
