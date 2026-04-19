'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  captures:    [],   // all captures, newest-first
  filtered:    [],   // after filter applied
  selectedId:  null,
  filter:      '',
  view:        'domains',  // 'timeline' | 'domains'
  dtab:        'overview', // 'overview' | 'request' | 'response'
  jsonMode:    false,      // toggle between pretty and raw JSON view
  recording:   true,
  ips:         [],
  proxyPort:   8888,
  connected:   false,
  domainOpen:  {},   // hostname → bool
  sslProxying: { enabled: true, locations: [{ host: '*', port: '' }] },
  mapLocal:    { enabled: false, mappings: [] },
};

// ─── WebSocket ────────────────────────────────────────────────────────────────
let ws = null;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    S.connected = true;
    updateStatusBar();
  };

  ws.onclose = () => {
    S.connected = false;
    updateStatusBar();
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = ({ data }) => {
    try { handle(JSON.parse(data)); } catch {}
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(msg) {
  switch (msg.type) {
    case 'init':
      S.recording  = msg.recording;
      S.proxyPort  = msg.proxyPort;
      S.ips        = msg.ips || [];
      S.captures   = msg.captures || [];
      S.filtered   = [...S.captures];
      applyFilter();
      renderAll();
      break;

    case 'capture':
      S.captures.unshift(msg.data);
      applyFilter();
      if (S.filter && !S.filtered.find(c => c.id === msg.data.id)) break;
      if (S.view === 'timeline') prependRow(msg.data);
      else renderDomainTree();
      updateCount();
      setTimeout(() => flashRow(msg.data.id), 10);
      break;

    case 'status':
      S.recording = msg.recording;
      S.ips       = msg.ips || [];
      S.proxyPort = msg.proxyPort;
      updateRecBadge();
      updateIPChips();
      updateStatusBar();
      break;

    case 'cleared':
      S.captures   = [];
      S.filtered   = [];
      S.selectedId = null;
      renderAll();
      break;

    case 'ssl_proxying':
      S.sslProxying = msg.data;
      updateSslStatusDot();
      break;

    case 'map_local':
      S.mapLocal = msg.data;
      updateMlStatusDot();
      break;
  }
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function applyFilter() {
  const q = S.filter.toLowerCase().trim();
  if (!q) { S.filtered = [...S.captures]; return; }

  const METHODS = ['get','post','put','delete','patch','head','options'];
  const isStatusQuery = /^\d+$/.test(q);
  const isMethodQuery = METHODS.includes(q);

  S.filtered = S.captures.filter(c => {
    // 1. Pure digits → status code only (e.g. "401", "20")
    if (isStatusQuery) return String(c.status ?? '').startsWith(q);

    // 2. HTTP method keyword → method only (e.g. "get", "post")
    if (isMethodQuery) return (c.method || '').toLowerCase() === q;

    // 3. General text search — host, URL, content-type, body
    return (
      c.host.toLowerCase().includes(q) ||
      c.url.toLowerCase().includes(q) ||
      (c.statusText   || '').toLowerCase().includes(q) ||
      (c.contentType  || '').toLowerCase().includes(q) ||
      (c.resBody      || '').toLowerCase().includes(q) ||
      (c.reqBody      || '').toLowerCase().includes(q)
    );
  });
}

// ─── Render All ───────────────────────────────────────────────────────────────
function renderAll() {
  updateRecBadge();
  updateIPChips();
  updateStatusBar();
  updateCount();

  if (S.view === 'timeline') renderTimeline();
  else renderDomainTree();

  if (S.selectedId) {
    const c = S.captures.find(x => x.id === S.selectedId);
    if (c) renderDetail(c);
    else   { S.selectedId = null; showEmptyState(); }
  } else {
    showEmptyState();
  }
}

// ─── Navbar UI ───────────────────────────────────────────────────────────────
function updateRecBadge() {
  const badge = $('recBadge');
  const dot   = $('recDot');
  const lbl   = $('recLabel');
  const icon  = $('recIcon');

  if (S.recording) {
    badge.classList.remove('paused');
    lbl.textContent = 'REC';
    icon.querySelector('use').setAttribute('href', '#i-pause');
  } else {
    badge.classList.add('paused');
    lbl.textContent = 'PAUSED';
    icon.querySelector('use').setAttribute('href', '#i-play');
  }
  $('portPill').textContent = `:${S.proxyPort}`;
}

function updateIPChips() {
  const wrap = $('ipChips');
  wrap.innerHTML = S.ips.map(ip =>
    `<span class="ip-chip">${esc(ip)}</span>`
  ).join('');
}

function updateStatusBar() {
  const dot  = $('sbDot');
  const text = $('sbText');
  const right = $('sbRight');

  dot.className = 'sb-dot ' + (S.connected ? 'connected' : 'disconnected');
  text.textContent = S.connected ? 'Connected' : 'Reconnecting…';

  const ip = S.ips[0] || 'localhost';
  right.textContent = `WiFi Proxy → ${ip}:${S.proxyPort}  (HTTP only)`;
}

function updateCount() {
  const n = S.filtered.length;
  $('reqCount').textContent = `${n} request${n !== 1 ? 's' : ''}`;
}

// ─── Timeline View ────────────────────────────────────────────────────────────
function renderTimeline() {
  const list = $('reqList');
  list.innerHTML = '';
  for (const c of S.filtered) {
    list.appendChild(makeRow(c));
  }
}

function makeRow(c) {
  const div = document.createElement('div');
  div.className = 'req-row' + (c.id === S.selectedId ? ' active' : '') + (c.mapLocal ? ' map-local' : '');
  div.dataset.id = c.id;

  const mClass  = 'm-' + (c.method || 'other');
  const sClass  = statusClass(c.status);
  const dClass  = durClass(c.duration);
  const lockIcon = c.proto === 'https'
    ? `<svg width="8" height="8" style="margin-right:2px;color:var(--success);opacity:.7"><use href="#i-lock"/></svg>`
    : '';
  const mlIcon = c.mapLocal
    ? `<span class="ml-badge" title="Map Local">⬤</span>`
    : '';

  div.innerHTML = `
    <span class="m-badge ${mClass}">${esc(c.method || '?')}</span>
    <span><span class="s-badge ${sClass}">${c.status || '—'}</span></span>
    <div class="row-url">
      <span class="row-host">${lockIcon}${esc(c.host)}${mlIcon}</span>
    </div>
    <span class="row-path-col" title="${esc(c.path)}">${esc(truncate(c.path, 28))}</span>
    <span class="row-size">${fmtBytes(c.resSize)}</span>
    <span class="row-dur">
      <span class="dur-dot ${dClass}"></span>
      ${fmtDur(c.duration)}
    </span>
  `;

  div.addEventListener('click', () => selectCapture(c.id));
  return div;
}

function prependRow(c) {
  if (!S.filtered.find(x => x.id === c.id)) return;
  const list = $('reqList');
  const row = makeRow(c);
  list.prepend(row);
  // Remove overflow
  while (list.children.length > 2000) list.lastChild.remove();
}

function flashRow(id) {
  const el = $('reqList').querySelector(`[data-id="${id}"]`);
  if (el) { el.classList.add('new-glow'); setTimeout(() => el.classList.remove('new-glow'), 700); }
}

// ─── Domain Tree ──────────────────────────────────────────────────────────────
function renderDomainTree() {
  const tree = $('domainTree');
  tree.innerHTML = '';

  // Group by host
  const groups = {};
  for (const c of S.filtered) {
    if (!groups[c.host]) groups[c.host] = [];
    groups[c.host].push(c);
  }

  for (const [host, items] of Object.entries(groups)) {
    const isOpen = !!S.domainOpen[host];
    const grp = document.createElement('div');
    grp.className = 'domain-group' + (isOpen ? ' open' : '');
    grp.dataset.host = host;

    grp.innerHTML = `
      <div class="domain-hdr">
        <svg class="domain-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        <span class="domain-name">${esc(host)}</span>
        <span class="domain-count">${items.length}</span>
      </div>
      <div class="domain-children">
        ${items.map(c => `
          <div class="domain-child ${c.id === S.selectedId ? 'active' : ''} ${c.mapLocal ? 'map-local' : ''}" data-id="${c.id}">
            <span class="dc-method m-${c.method}">${esc(c.method)}</span>
            <span class="dc-path" title="${esc(c.path)}">${esc(truncate(c.path, 40))}${c.mapLocal ? '<span class="ml-badge" title="Map Local">⬤</span>' : ''}</span>
            <span class="dc-status ${statusClass(c.status)}">${c.status || '—'}</span>
          </div>
        `).join('')}
      </div>
    `;

    grp.querySelector('.domain-hdr').addEventListener('click', () => {
      S.domainOpen[host] = !S.domainOpen[host];
      grp.classList.toggle('open');
    });

    grp.querySelectorAll('.domain-child').forEach(el => {
      el.addEventListener('click', () => selectCapture(el.dataset.id));
    });

    tree.appendChild(grp);
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────
function selectCapture(id) {
  S.selectedId = id;

  // Highlight active row
  document.querySelectorAll('.req-row').forEach(r => r.classList.toggle('active', r.dataset.id === id));
  document.querySelectorAll('.domain-child').forEach(r => r.classList.toggle('active', r.dataset.id === id));

  const c = S.captures.find(x => x.id === id);
  if (c) renderDetail(c);
}

function showEmptyState() {
  $('emptyState').classList.remove('hidden');
  $('detail').classList.add('hidden');

  const ip = S.ips[0] || 'your-ip';
  $('emptyHint').textContent =
    `Set WiFi proxy to ${ip}:${S.proxyPort}\nthen browse on your device`;
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────
function renderDetail(c) {
  $('emptyState').classList.add('hidden');
  $('detail').classList.remove('hidden');

  // Wire cURL button
  $('btnCurl').onclick = () => {
    copyText(generateCurl(c), $('btnCurl'));
  };

  // Wire Map Local button
  $('btnMapLocal').onclick = () => {
    mapLocalFromCapture(c);
  };

  // Re-render current active tab
  renderDetailTab(c, S.dtab);
}

function renderDetailTab(c, tab) {
  S.dtab = tab;
  document.querySelectorAll('.dtab').forEach(b => b.classList.toggle('active', b.dataset.dtab === tab));
  document.querySelectorAll('.dview').forEach(v => v.classList.add('hidden'));

  if (tab === 'overview') {
    $('dvOverview').classList.remove('hidden');
    renderOverview(c);
  } else if (tab === 'request') {
    $('dvRequest').classList.remove('hidden');
    renderRequestTab(c);
  } else {
    $('dvResponse').classList.remove('hidden');
    renderResponseTab(c);
  }
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────
function renderOverview(c) {
  if (S.jsonMode) {
    const obj = {
      url: c.url, method: c.method, status: c.status, statusText: c.statusText,
      protocol: c.proto, host: c.host, port: c.port, path: c.path,
      contentType: c.contentType || null, duration_ms: c.duration,
      timestamp: fmtTime(c.ts), reqSize: c.reqSize, resSize: c.resSize,
    };
    return renderJsonView($('dvOverview'), obj);
  }

  const sClass = statusClass(c.status);
  const mClass = 'm-' + (c.method || 'other');
  const dur    = c.duration || 0;

  $('dvOverview').innerHTML = `
    <div class="ov-grid">
      <div class="ov-row"><div class="ov-key">URL</div><div class="ov-val url-val" style="word-break:break-all">${esc(c.url)}</div></div>
      <div class="ov-row"><div class="ov-key">Status</div><div class="ov-val"><span class="status-pill ${sClass}">${c.status || 'Error'} ${esc(c.statusText || '')}</span></div></div>
      <div class="ov-row"><div class="ov-key">Method</div><div class="ov-val"><span class="m-badge ${mClass}">${esc(c.method)}</span></div></div>
      <div class="ov-row"><div class="ov-key">Host</div><div class="ov-val">${esc(c.host)}${c.port && c.port !== '80' ? ':'+esc(c.port) : ''}</div></div>
      <div class="ov-row"><div class="ov-key">Path</div><div class="ov-val" style="word-break:break-all">${esc(c.path)}</div></div>
      <div class="ov-row"><div class="ov-key">Protocol</div><div class="ov-val">${c.proto === 'https'
        ? `<svg width="10" height="10" style="color:var(--success);vertical-align:middle;margin-right:4px"><use href="#i-lock"/></svg><span style="color:var(--success)">HTTPS</span>`
        : `<span style="color:var(--text-3)">HTTP</span>`}</div></div>
      <div class="ov-row"><div class="ov-key">Content-Type</div><div class="ov-val">${esc(c.contentType || '—')}</div></div>
      <div class="ov-row"><div class="ov-key">Req Size</div><div class="ov-val">${fmtBytes(c.reqSize)}</div></div>
      <div class="ov-row"><div class="ov-key">Res Size</div><div class="ov-val">${fmtBytes(c.resSize)}</div></div>
      <div class="ov-row"><div class="ov-key">Time</div><div class="ov-val">${fmtTime(c.ts)}</div></div>
      ${c.mapLocal ? `<div class="ov-row"><div class="ov-key">Source</div><div class="ov-val"><span class="ml-source-pill">⬤ Map Local</span>${c.resHeaders && c.resHeaders['x-map-local'] ? ` <span style="color:var(--text-3);font-size:11px">${esc(c.resHeaders['x-map-local'])}</span>` : ''}</div></div>` : ''}
    </div>
    <div class="timing-section">
      <div class="timing-title">Timing</div>
      <div class="timing-row">
        <span class="timing-lbl">Total</span>
        <div class="timing-track"><div class="timing-fill" style="width:100%;background:var(--accent)"></div></div>
        <span class="timing-val">${dur}ms</span>
      </div>
      <div class="timing-row">
        <span class="timing-lbl">TTFB</span>
        <div class="timing-track"><div class="timing-fill" style="width:${Math.min(100, Math.round(dur * 0.7))}%;background:var(--success)"></div></div>
        <span class="timing-val">~${Math.round(dur * 0.7)}ms</span>
      </div>
      <div class="timing-row">
        <span class="timing-lbl">Transfer</span>
        <div class="timing-track"><div class="timing-fill" style="width:${Math.min(100, Math.round(dur * 0.3))}%;background:var(--warning)"></div></div>
        <span class="timing-val">~${Math.round(dur * 0.3)}ms</span>
      </div>
    </div>
  `;
}

// ─── Request Tab ──────────────────────────────────────────────────────────────
function renderRequestTab(c) {
  if (S.jsonMode) {
    let body = null;
    if (c.reqBody) { try { body = JSON.parse(c.reqBody); } catch { body = c.reqBody; } }
    return renderJsonView($('dvRequest'), { headers: c.reqHeaders || {}, body }, c.reqBodyTrunc);
  }
  const hdrCount = Object.keys(c.reqHeaders || {}).length;
  $('dvRequest').innerHTML = `
    ${makeHeadersSection('Request Headers', c.reqHeaders, hdrCount)}
    ${makeBodySection('Request Body', c.reqBody, c.reqBodyTrunc, false)}
  `;
  wireSection($('dvRequest'));
}

// ─── Response Tab ─────────────────────────────────────────────────────────────
function renderResponseTab(c) {
  if (S.jsonMode) {
    let body = null;
    if (c.resBodyBin) {
      body = c.contentType?.startsWith('image/')
        ? `[image — /api/captures/${c.id}/body]`
        : `[binary: ${c.contentType || 'application/octet-stream'}]`;
    } else if (c.resBody) {
      try { body = JSON.parse(c.resBody); } catch { body = c.resBody; }
    }
    return renderJsonView($('dvResponse'), { headers: c.resHeaders || {}, body }, c.resBodyTrunc);
  }
  const hdrCount = Object.keys(c.resHeaders || {}).length;
  $('dvResponse').innerHTML = `
    ${makeHeadersSection('Response Headers', c.resHeaders, hdrCount)}
    ${makeBodySection('Response Body', c.resBody, c.resBodyTrunc, c.resBodyBin, c.contentType, c.id)}
  `;
  wireSection($('dvResponse'));
}

// ─── Shared JSON view renderer ────────────────────────────────────────────────
function renderJsonView(container, obj, truncated = false) {
  const text = JSON.stringify(obj, null, 2);
  const truncWarn = truncated
    ? `<div class="trunc-warn">⚠ Body truncated to 256 KB for display</div>`
    : '';
  container.innerHTML = `
    ${truncWarn}
    <div class="body-editor-wrap">
      <pre class="be-gutter" data-gutter></pre>
      <div class="be-area">
        <pre class="be-highlight" data-highlight>${highlightJSON(text)}</pre>
        <textarea class="be-textarea" readonly spellcheck="false">${escHtml(text)}</textarea>
      </div>
    </div>
    <div class="fmt-bar">
      <span class="fmt-status valid">✓ JSON</span>
      <button class="sec-copy fmt-btn" data-copy="${esc(text)}">Copy</button>
    </div>
  `;

  const ta = container.querySelector('.be-textarea');
  const hl = container.querySelector('.be-highlight');
  const gt = container.querySelector('[data-gutter]');
  if (gt) renderGutter(ta, gt);
  ta.addEventListener('scroll', () => syncScroll(ta, hl, gt));

  container.querySelector('.sec-copy').addEventListener('click', e => {
    e.stopPropagation();
    copyText(e.currentTarget.dataset.copy, e.currentTarget);
  });
}

// ─── Section Builders ─────────────────────────────────────────────────────────
function makeHeadersSection(title, headers, count) {
  const hdrsObj = headers || {};
  const rows = Object.entries(hdrsObj)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : v)}</td></tr>`)
    .join('');

  const headersJson = JSON.stringify(hdrsObj, null, 2);

  return `
    <div class="section open">
      <div class="section-hdr">
        <svg class="sec-chev" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        <span class="sec-title">${esc(title)}</span>
        <span class="sec-count">${count}</span>
        <button class="sec-copy" data-copy="${esc(headersJson)}" title="Copy headers as JSON">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          Copy
        </button>
      </div>
      <div class="section-body">
        <table class="hdrs-table">
          <tbody>${rows || '<tr><td colspan="2" style="text-align:center;color:var(--text-3);padding:12px">No headers</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

function makeBodySection(title, body, truncated, isBinary, contentType = '', captureId = '') {
  let bodyContent = '';

  if (isBinary) {
    if (contentType.startsWith('image/')) {
      bodyContent = `
        <div class="body-image-wrap">
          <img src="/api/captures/${captureId}/body"
               class="body-image-preview"
               alt="${esc(contentType)}"
               onerror="this.parentElement.innerHTML='<div class=\\'body-binary-meta\\'><div class=\\'bin-type\\'>${esc(contentType)}</div><div class=\\'bin-note\\'>Image failed to load</div></div>'">
        </div>`;
    } else {
      bodyContent = `
        <div class="body-binary-meta">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="opacity:.25;flex-shrink:0"><path d="M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>
          <div>
            <div class="bin-type">${esc(contentType || 'application/octet-stream')}</div>
            <div class="bin-note">Binary — not displayable as text</div>
          </div>
        </div>`;
    }
  } else if (!body) {
    bodyContent = `<div class="body-empty">No body</div>`;
  } else {
    // Try to pretty-print JSON
    let displayBody = body;
    let isJson = false;
    if (contentType.includes('json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
      try {
        displayBody = JSON.stringify(JSON.parse(body), null, 2);
        isJson = true;
      } catch {}
    }

    const truncWarn = truncated
      ? `<div class="trunc-warn">⚠ Response truncated to 256 KB for display</div>`
      : '';

    bodyContent = `
      ${truncWarn}
      <div class="body-editor-wrap">
        <pre class="be-gutter" data-gutter></pre>
        <div class="be-area">
          <pre class="be-highlight" data-highlight>${isJson ? highlightJSON(displayBody) : escHtml(displayBody)}</pre>
          <textarea class="be-textarea" readonly spellcheck="false">${escHtml(displayBody)}</textarea>
        </div>
      </div>
      ${isJson ? `
      <div class="fmt-bar">
        <span class="fmt-status valid">✓ Valid JSON</span>
        <button class="fmt-btn" data-fmt>Format</button>
      </div>
      ` : ''}
    `;
  }

  const rawBody = body || '';

  return `
    <div class="section open">
      <div class="section-hdr">
        <svg class="sec-chev" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        <span class="sec-title">${esc(title)}</span>
        <span class="sec-count">${body ? fmtBytes(body.length) : '—'}</span>
        ${body ? `<button class="sec-copy" data-copy="${esc(rawBody)}" title="Copy body">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          Copy
        </button>` : ''}
      </div>
      <div class="section-body">${bodyContent}</div>
    </div>
  `;
}

// ─── Wire sections after innerHTML ───────────────────────────────────────────
function wireSection(container) {
  // Collapsible toggle
  container.querySelectorAll('.section-hdr').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('.sec-copy, .fmt-btn')) return;
      hdr.closest('.section').classList.toggle('open');
    });
  });

  // Copy buttons
  container.querySelectorAll('.sec-copy').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      copyText(btn.dataset.copy, btn);
    });
  });

  // Format JSON button
  container.querySelectorAll('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.section');
      const ta = section.querySelector('.be-textarea');
      const hl = section.querySelector('.be-highlight');
      const gt = section.querySelector('[data-gutter]');
      if (!ta) return;
      try {
        const pretty = JSON.stringify(JSON.parse(ta.value), null, 2);
        ta.value = pretty;
        hl.innerHTML = highlightJSON(pretty);
        if (gt) renderGutter(ta, gt);
        syncScroll(ta, hl, gt);
      } catch {}
    });
  });

  // Wire editors (gutter + scroll sync)
  container.querySelectorAll('.be-textarea').forEach(ta => {
    const area = ta.closest('.be-area');
    const hl   = area.querySelector('.be-highlight');
    const wrap = ta.closest('.body-editor-wrap');
    const gt   = wrap ? wrap.querySelector('[data-gutter]') : null;

    if (gt) renderGutter(ta, gt);

    ta.addEventListener('scroll', () => syncScroll(ta, hl, gt));
  });
}

// ─── JSON Editor helpers (borrowed from local-shareanyjson) ───────────────────

// Identical to local-shareanyjson's highlightJSON — same regex, same class names
function highlightJSON(code) {
  const safe = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return safe.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, kw, num) => {
      if (str !== undefined)
        return colon !== undefined
          ? `<span class="json-key">${str}</span>${colon}`
          : `<span class="json-str">${match}</span>`;
      if (kw  !== undefined) return `<span class="json-kw">${match}</span>`;
      if (num !== undefined) return `<span class="json-num">${match}</span>`;
      return match;
    }
  );
}

function renderGutter(ta, gt) {
  const lines = ta.value.split('\n').length;
  gt.innerHTML = Array.from({ length: lines }, (_, i) =>
    `<span class="be-gutter-line">${i + 1}</span>`
  ).join('');
}

function syncScroll(ta, hl, gt) {
  if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
  if (gt) gt.scrollTop = ta.scrollTop;
}

// ─── HAR Export ───────────────────────────────────────────────────────────────
function exportHAR() {
  if (!S.captures.length) { toast('No captures to export', 'info'); return; }

  const entries = [...S.filtered].reverse().map(c => {
    const toHdrArr = obj => Object.entries(obj || {}).map(([name, value]) => ({
      name, value: Array.isArray(value) ? value.join(', ') : String(value),
    }));

    let queryString = [];
    try {
      const u = new URL(c.url);
      for (const [name, value] of u.searchParams) queryString.push({ name, value });
    } catch {}

    const entry = {
      startedDateTime: new Date(c.ts).toISOString(),
      time:            c.duration || 0,
      request: {
        method:      c.method || 'GET',
        url:         c.url,
        httpVersion: 'HTTP/1.1',
        headers:     toHdrArr(c.reqHeaders),
        queryString,
        cookies:     [],
        headersSize: -1,
        bodySize:    c.reqSize || -1,
      },
      response: {
        status:      c.status || 0,
        statusText:  c.statusText || '',
        httpVersion: 'HTTP/1.1',
        headers:     toHdrArr(c.resHeaders),
        cookies:     [],
        content: {
          size:     c.resSize || 0,
          mimeType: c.contentType || 'application/octet-stream',
          ...(c.resBody ? { text: c.resBody } : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize:    c.resSize || -1,
      },
      cache:   {},
      timings: { send: 0, wait: c.duration || 0, receive: 0 },
    };

    if (c.reqBody) {
      entry.request.postData = {
        mimeType: (c.reqHeaders || {})['content-type'] || 'text/plain',
        text:     c.reqBody,
      };
    }

    return entry;
  });

  const har = { log: { version: '1.2', creator: { name: 'APIWebProxy', version: '1.0' }, entries } };
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `localproxy-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.har`;
  a.click();
  URL.revokeObjectURL(url);
  const filteredNote = S.filter ? ` (filtered)` : '';
  toast(`Exported ${entries.length} request${entries.length !== 1 ? 's' : ''}${filteredNote} as HAR`, 'success');
}

// ─── cURL Generator ───────────────────────────────────────────────────────────
function generateCurl(c) {
  const parts = [`curl -X ${c.method} '${c.url}'`];
  for (const [k, v] of Object.entries(c.reqHeaders || {})) {
    const lower = k.toLowerCase();
    if (lower === 'proxy-connection' || lower === 'host') continue;
    const val = Array.isArray(v) ? v.join(', ') : v;
    parts.push(`  -H '${k}: ${val.replace(/'/g, "\\'")}'`);
  }
  if (c.reqBody) {
    parts.push(`  -d '${c.reqBody.replace(/'/g, "\\'")}'`);
  }
  return parts.join(' \\\n');
}

// ─── Clipboard ────────────────────────────────────────────────────────────────
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    toast('Copied!', 'success');
    if (btn) {
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
    }
  }).catch(() => toast('Copy failed', 'error'));
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ─── Resize Handle ────────────────────────────────────────────────────────────
function initResize() {
  const handle = $('resizeHandle');
  const left   = $('leftPanel');
  const main   = $('main');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = left.offsetWidth;
    handle.classList.add('resizing');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx  = e.clientX - startX;
    const max = main.offsetWidth - 300;
    left.style.width = Math.max(220, Math.min(startW + dx, max)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('resizing');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

// ─── Keyboard Navigation ──────────────────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = S.filtered;
      if (!list.length) return;
      const idx  = list.findIndex(c => c.id === S.selectedId);
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, list.length - 1)
        : Math.max(idx - 1, 0);
      selectCapture(list[next].id);
      const row = $('reqList').querySelector(`[data-id="${list[next].id}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    if (e.key === ' ') {
      e.preventDefault();
      send({ type: 'toggle_recording' });
    }

    if (e.key === 'e' || e.key === 'E') {
      exportHAR();
    }

    if (e.key === 'Escape') {
      S.selectedId = null;
      document.querySelectorAll('.req-row').forEach(r => r.classList.remove('active'));
      document.querySelectorAll('.domain-child').forEach(r => r.classList.remove('active'));
      showEmptyState();
    }
  });
}

// ─── View Tabs ────────────────────────────────────────────────────────────────
function initViewTabs() {
  document.querySelectorAll('.vtab').forEach(btn => {
    btn.addEventListener('click', () => {
      S.view = btn.dataset.view;
      document.querySelectorAll('.vtab').forEach(b => b.classList.toggle('active', b === btn));
      $('viewTimeline').classList.toggle('hidden', S.view !== 'timeline');
      $('viewDomains').classList.toggle('hidden',  S.view !== 'domains');

      if (S.view === 'timeline') renderTimeline();
      else renderDomainTree();
    });
  });
}

// ─── Detail Tabs ──────────────────────────────────────────────────────────────
function initDetailTabs() {
  document.querySelectorAll('.dtab').forEach(btn => {
    if (!btn.dataset.dtab) return;
    btn.addEventListener('click', () => {
      const c = S.captures.find(x => x.id === S.selectedId);
      if (c) renderDetailTab(c, btn.dataset.dtab);
    });
  });

  $('btnJsonToggle').addEventListener('click', () => {
    S.jsonMode = !S.jsonMode;
    $('btnJsonToggle').classList.toggle('active', S.jsonMode);
    const c = S.captures.find(x => x.id === S.selectedId);
    if (c) renderDetailTab(c, S.dtab);
  });
}

// ─── Filter Input ─────────────────────────────────────────────────────────────
function initFilter() {
  const input    = $('filterInput');
  const clearBtn = $('clearFilter');

  input.addEventListener('input', () => {
    S.filter = input.value;
    clearBtn.classList.toggle('hidden', !S.filter);
    applyFilter();
    if (S.view === 'timeline') renderTimeline();
    else renderDomainTree();
    updateCount();
  });

  clearBtn.addEventListener('click', () => {
    input.value  = '';
    S.filter     = '';
    clearBtn.classList.add('hidden');
    applyFilter();
    if (S.view === 'timeline') renderTimeline();
    else renderDomainTree();
    updateCount();
  });
}

// ─── Tools Dropdown ───────────────────────────────────────────────────────────
function initToolsDropdown() {
  const btn  = $('btnTools');
  const menu = $('toolsMenu');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.classList.contains('hidden');
    if (open) {
      menu.classList.add('hidden');
      btn.classList.remove('active');
    } else {
      menu.classList.remove('hidden');
      btn.classList.add('active');
    }
  });

  // Close on outside click
  document.addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('active');
  });

  $('menuSslProxying').addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('active');
    openSslModal();
  });

  $('menuMapLocal').addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('active');
    openMlModal();
  });

  // Fetch current settings from server
  fetch('/api/ssl-proxying')
    .then(r => r.json())
    .then(data => { S.sslProxying = data; updateSslStatusDot(); })
    .catch(() => {});

  fetch('/api/map-local')
    .then(r => r.json())
    .then(data => { S.mapLocal = data; updateMlStatusDot(); })
    .catch(() => {});
}

function updateSslStatusDot() {
  const dot = $('sslStatusDot');
  if (!dot) return;
  dot.classList.remove('on', 'off');
  dot.classList.add(S.sslProxying.enabled ? 'on' : 'off');
}

function updateMlStatusDot() {
  const dot = $('mlStatusDot');
  if (!dot) return;
  dot.classList.remove('on', 'off');
  dot.classList.add(S.mapLocal.enabled ? 'on' : 'off');
}

// ─── SSL Proxying Modal ───────────────────────────────────────────────────────
let _sslDraft = null; // working copy while modal is open
let _sslSelectedRow = -1;

function openSslModal() {
  _sslDraft = {
    enabled:   S.sslProxying.enabled,
    locations: S.sslProxying.locations.map(l => ({ ...l })),
  };
  _sslSelectedRow = -1;
  $('sslEnabled').checked = _sslDraft.enabled;
  renderSslLocations();
  $('sslOverlay').classList.remove('hidden');
}

function closeSslModal() {
  $('sslOverlay').classList.add('hidden');
  _sslDraft = null;
  _sslSelectedRow = -1;
}

// Toggle selected row class without touching input DOM — preserves focus & caret
function selectSslRow(idx) {
  _sslSelectedRow = idx;
  $('sslLocationsList').querySelectorAll('.ssl-loc-row').forEach((r, i) => {
    r.classList.toggle('selected', i === idx);
  });
}

// Build one row and append it. idx is its position in _sslDraft.locations.
function appendSslRow(idx, loc) {
  const list = $('sslLocationsList');

  const row = document.createElement('div');
  row.className = 'ssl-loc-row' + (idx === _sslSelectedRow ? ' selected' : '');

  const mkInput = (field, value, placeholder, extraClass) => {
    const inp = document.createElement('input');
    inp.type        = 'text';
    inp.className   = 'ssl-loc-input' + (extraClass ? ' ' + extraClass : '');
    inp.value       = value;
    inp.placeholder = placeholder;
    inp.spellcheck  = false;
    inp.autocomplete = 'off';

    inp.addEventListener('focus', () => selectSslRow(idx));

    inp.addEventListener('input', () => {
      _sslDraft.locations[idx][field] = inp.value;
    });

    inp.addEventListener('keydown', e => {
      const rows = $('sslLocationsList').querySelectorAll('.ssl-loc-row');
      const inputs = row.querySelectorAll('.ssl-loc-input');
      const isHost = field === 'host';
      const isPort = field === 'port';

      if (e.key === 'Tab') {
        e.preventDefault();
        if (!e.shiftKey) {
          // Forward: host → port → next row's host → … → add new row
          if (isHost) { inputs[1].focus(); }
          else if (idx < _sslDraft.locations.length - 1) {
            rows[idx + 1].querySelectorAll('.ssl-loc-input')[0].focus();
          } else {
            addSslRow();
          }
        } else {
          // Backward: port → host → prev row's port
          if (isPort) { inputs[0].focus(); }
          else if (idx > 0) {
            rows[idx - 1].querySelectorAll('.ssl-loc-input')[1].focus();
          }
        }
      }

      if (e.key === 'Enter') {
        if (idx < _sslDraft.locations.length - 1) {
          rows[idx + 1].querySelectorAll('.ssl-loc-input')[0].focus();
        } else {
          addSslRow();
        }
      }
    });

    return inp;
  };

  row.appendChild(mkInput('host', loc.host, '*'));
  row.appendChild(mkInput('port', loc.port, '443', 'ssl-loc-port'));

  // Clicking the row background (not an input) still marks it selected
  row.addEventListener('mousedown', e => {
    if (e.target === row) selectSslRow(idx);
  });

  list.appendChild(row);
  return row;
}

// Full re-render — call only on open or after structural change (Remove)
function renderSslLocations() {
  $('sslLocationsList').innerHTML = '';
  _sslDraft.locations.forEach((loc, i) => appendSslRow(i, loc));
}

// Append one new location row and focus its host input
function addSslRow() {
  if (!_sslDraft) return;
  const idx = _sslDraft.locations.length;
  _sslDraft.locations.push({ host: '', port: '' });
  selectSslRow(idx);
  const row = appendSslRow(idx, _sslDraft.locations[idx]);
  row.querySelectorAll('.ssl-loc-input')[0].focus();
}

// Remove selected row, re-render (indices shift), restore focus
function removeSslRow() {
  if (!_sslDraft || _sslSelectedRow < 0 || !_sslDraft.locations.length) return;
  _sslDraft.locations.splice(_sslSelectedRow, 1);
  _sslSelectedRow = Math.min(_sslSelectedRow, _sslDraft.locations.length - 1);
  renderSslLocations();
  const rows = $('sslLocationsList').querySelectorAll('.ssl-loc-row');
  if (rows[_sslSelectedRow]) {
    rows[_sslSelectedRow].querySelectorAll('.ssl-loc-input')[0].focus();
  }
}

function initSslModal() {
  $('sslEnabled').addEventListener('change', e => {
    if (_sslDraft) _sslDraft.enabled = e.target.checked;
  });

  $('sslAddLocation').addEventListener('click', addSslRow);
  $('sslRemoveLocation').addEventListener('click', removeSslRow);

  $('sslOk').addEventListener('click', async () => {
    if (!_sslDraft) return;
    try {
      const res = await fetch('/api/ssl-proxying', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(_sslDraft),
      });
      const data = await res.json();
      S.sslProxying = data;
      updateSslStatusDot();
      toast(`SSL proxying ${data.enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch {
      toast('Failed to save SSL settings', 'error');
    }
    closeSslModal();
  });

  $('sslCancel').addEventListener('click', closeSslModal);
  $('sslClose').addEventListener('click',  closeSslModal);
  $('sslOverlay').addEventListener('click', e => {
    if (e.target === $('sslOverlay')) closeSslModal();
  });
}

// ─── Map Local Modal ─────────────────────────────────────────────────────────
let _mlDraft = null;
let _mlSelectedRow = -1;
let _mlEditIdx = -1; // index of mapping being edited in sub-modal

function openMlModal(prefill) {
  _mlDraft = {
    enabled:  S.mapLocal.enabled,
    mappings: S.mapLocal.mappings.map(m => ({ ...m })),
  };
  _mlSelectedRow = -1;
  $('mlEnabled').checked = _mlDraft.enabled;
  renderMlMappings();
  $('mlOverlay').classList.remove('hidden');

  // If prefill provided (from "Map this request" action), auto-add
  if (prefill) {
    _mlDraft.mappings.push({
      enabled: true,
      protocol: prefill.proto || '*',
      host:     prefill.host || '',
      port:     prefill.port || '',
      path:     prefill.path || '',
      query:    '',
      localPath: '',
      caseSensitive: false,
    });
    _mlSelectedRow = _mlDraft.mappings.length - 1;
    renderMlMappings();
    // Open edit modal for the new mapping
    openMlEditModal(_mlSelectedRow);
  }
}

function closeMlModal() {
  $('mlOverlay').classList.add('hidden');
  _mlDraft = null;
  _mlSelectedRow = -1;
}

function renderMlMappings() {
  const list = $('mlMappingsList');
  list.innerHTML = '';
  if (!_mlDraft) return;

  _mlDraft.mappings.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'ml-map-row' + (i === _mlSelectedRow ? ' selected' : '');

    const enabledClass = m.enabled ? 'ml-check-on' : 'ml-check-off';
    const host = m.host || '*';
    const pathDisplay = m.path || '/';
    const localDisplay = m.localPath || '(not set)';

    row.innerHTML = `
      <span class="ml-map-enabled ${enabledClass}" data-idx="${i}" title="Toggle enabled">
        ${m.enabled ? '✓' : ''}
      </span>
      <span class="ml-map-host">${esc(host)}</span>
      <span class="ml-map-path" title="${esc(pathDisplay)}">${esc(truncate(pathDisplay, 20))}</span>
      <span class="ml-map-local" title="${esc(localDisplay)}">${esc(truncate(localDisplay, 25))}</span>
    `;

    row.addEventListener('click', e => {
      if (e.target.closest('.ml-map-enabled')) {
        _mlDraft.mappings[i].enabled = !_mlDraft.mappings[i].enabled;
        renderMlMappings();
        return;
      }
      _mlSelectedRow = i;
      renderMlMappings();
    });

    row.addEventListener('dblclick', e => {
      if (e.target.closest('.ml-map-enabled')) return;
      openMlEditModal(i);
    });

    list.appendChild(row);
  });
}

function openMlEditModal(idx) {
  _mlEditIdx = idx;
  const m = _mlDraft.mappings[idx];
  if (!m) return;

  $('mlEditProtocol').value     = m.protocol || '*';
  $('mlEditHost').value         = m.host || '';
  $('mlEditPort').value         = m.port || '';
  $('mlEditPath').value         = m.path || '';
  $('mlEditQuery').value        = m.query || '';
  $('mlEditLocalPath').value    = m.localPath || '';
  $('mlEditCaseSensitive').checked = m.caseSensitive || false;

  $('mlEditOverlay').classList.remove('hidden');
}

function closeMlEditModal() {
  $('mlEditOverlay').classList.add('hidden');
  _mlEditIdx = -1;
}

function saveMlEditModal() {
  if (_mlEditIdx < 0 || !_mlDraft) return;
  const m = _mlDraft.mappings[_mlEditIdx];
  m.protocol      = $('mlEditProtocol').value;
  m.host          = $('mlEditHost').value.trim();
  m.port          = $('mlEditPort').value.trim();
  m.path          = $('mlEditPath').value.trim();
  m.query         = $('mlEditQuery').value.trim();
  m.localPath     = $('mlEditLocalPath').value.trim();
  m.caseSensitive = $('mlEditCaseSensitive').checked;

  closeMlEditModal();
  renderMlMappings();
}

function initMlModal() {
  $('mlEnabled').addEventListener('change', e => {
    if (_mlDraft) _mlDraft.enabled = e.target.checked;
  });

  $('mlAddMapping').addEventListener('click', () => {
    if (!_mlDraft) return;
    _mlDraft.mappings.push({
      enabled: true, protocol: '*', host: '', port: '', path: '', query: '',
      localPath: '', caseSensitive: false,
    });
    _mlSelectedRow = _mlDraft.mappings.length - 1;
    renderMlMappings();
    openMlEditModal(_mlSelectedRow);
  });

  $('mlRemoveMapping').addEventListener('click', () => {
    if (!_mlDraft || _mlSelectedRow < 0 || !_mlDraft.mappings.length) return;
    _mlDraft.mappings.splice(_mlSelectedRow, 1);
    _mlSelectedRow = Math.min(_mlSelectedRow, _mlDraft.mappings.length - 1);
    renderMlMappings();
  });

  $('mlOk').addEventListener('click', async () => {
    if (!_mlDraft) return;
    try {
      const res = await fetch('/api/map-local', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(_mlDraft),
      });
      const data = await res.json();
      S.mapLocal = data;
      updateMlStatusDot();
      toast(`Map Local ${data.enabled ? 'enabled' : 'disabled'} (${data.mappings.length} mapping${data.mappings.length !== 1 ? 's' : ''})`, 'success');
    } catch {
      toast('Failed to save Map Local settings', 'error');
    }
    closeMlModal();
  });

  $('mlCancel').addEventListener('click', closeMlModal);
  $('mlClose').addEventListener('click',  closeMlModal);
  $('mlOverlay').addEventListener('click', e => {
    if (e.target === $('mlOverlay')) closeMlModal();
  });

  // Edit sub-modal
  $('mlEditOk').addEventListener('click', saveMlEditModal);
  $('mlEditCancel').addEventListener('click', closeMlEditModal);
  $('mlEditClose').addEventListener('click',  closeMlEditModal);
  $('mlEditOverlay').addEventListener('click', e => {
    if (e.target === $('mlEditOverlay')) closeMlEditModal();
  });

  // Browse button opens file browser, feeds path back into the input
  $('mlBrowseBtn').addEventListener('click', () => {
    const currentVal = $('mlEditLocalPath').value.trim();
    openFileBrowser(currentVal, selectedPath => {
      $('mlEditLocalPath').value = selectedPath;
    });
  });
}

// Helper: open Map Local pre-filled from the currently selected capture
function mapLocalFromCapture(c) {
  if (!c) return;
  let urlPath = c.path || '/';
  let port = c.port || '';
  if (c.proto === 'https' && port === '443') port = '';
  if (c.proto === 'http'  && port === '80')  port = '';

  openMlModal({
    proto: c.proto,
    host:  c.host,
    port:  port,
    path:  urlPath.split('?')[0],
  });
}

// ─── File Browser Modal ──────────────────────────────────────────────────────
let _fbCurrentPath = '';
let _fbSelectedPath = '';
let _fbOnSelect = null; // callback(path) when user confirms selection

function openFileBrowser(startPath, onSelect) {
  _fbOnSelect = onSelect;
  _fbSelectedPath = '';
  $('fbOverlay').classList.remove('hidden');
  browseDir(startPath || '');
}

function closeFileBrowser() {
  $('fbOverlay').classList.add('hidden');
  _fbOnSelect = null;
}

async function browseDir(dir) {
  const list = $('fbList');
  list.innerHTML = '<div class="fb-loading">Loading…</div>';

  try {
    const params = dir ? `?path=${encodeURIComponent(dir)}` : '';
    const res = await fetch(`/api/browse${params}`);
    const data = await res.json();

    if (data.error) {
      list.innerHTML = `<div class="fb-error">${esc(data.error)}</div>`;
      return;
    }

    // If server returned a file, select it directly
    if (data.isFile) {
      _fbSelectedPath = data.path;
      _fbCurrentPath = data.path.substring(0, data.path.lastIndexOf('\\') || data.path.lastIndexOf('/'));
      $('fbPathInput').value = _fbCurrentPath;
      renderFileBrowser({ path: _fbCurrentPath, parent: null, items: [] });
      // Re-browse the parent directory
      browseDir(_fbCurrentPath);
      return;
    }

    _fbCurrentPath = data.path;
    $('fbPathInput').value = data.path;
    renderFileBrowser(data);
  } catch {
    list.innerHTML = '<div class="fb-error">Failed to load directory</div>';
  }
}

function renderFileBrowser(data) {
  const list = $('fbList');
  list.innerHTML = '';

  if (!data.items || !data.items.length) {
    list.innerHTML = '<div class="fb-empty">Empty directory</div>';
    return;
  }

  for (const item of data.items) {
    const row = document.createElement('div');
    row.className = 'fb-item' + (item.path === _fbSelectedPath ? ' selected' : '');
    row.dataset.path = item.path;
    row.dataset.isDir = item.isDir ? '1' : '0';

    const icon = item.isDir ? '📁' : '📄';
    row.innerHTML = `<span class="fb-icon">${icon}</span><span class="fb-name">${esc(item.name)}</span>`;

    row.addEventListener('click', () => {
      _fbSelectedPath = item.path;
      list.querySelectorAll('.fb-item').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
    });

    row.addEventListener('dblclick', () => {
      if (item.isDir) {
        browseDir(item.path);
      } else {
        // Double-click file = select and confirm
        _fbSelectedPath = item.path;
        confirmFileBrowser();
      }
    });

    list.appendChild(row);
  }
}

function confirmFileBrowser() {
  if (!_fbSelectedPath) {
    toast('Select a file or folder first', 'info');
    return;
  }
  if (_fbOnSelect) _fbOnSelect(_fbSelectedPath);
  closeFileBrowser();
}

function initFileBrowser() {
  $('fbClose').addEventListener('click', closeFileBrowser);
  $('fbCancel').addEventListener('click', closeFileBrowser);
  $('fbOverlay').addEventListener('click', e => {
    if (e.target === $('fbOverlay')) closeFileBrowser();
  });

  $('fbSelect').addEventListener('click', confirmFileBrowser);

  $('fbUp').addEventListener('click', () => {
    // Go to parent
    const sep = _fbCurrentPath.includes('\\') ? '\\' : '/';
    const parts = _fbCurrentPath.split(sep).filter(Boolean);
    if (parts.length > 1) {
      parts.pop();
      const parent = _fbCurrentPath.startsWith(sep)
        ? sep + parts.join(sep)
        : parts.join(sep) + sep;
      browseDir(parent);
    } else if (_fbCurrentPath.match(/^[A-Z]:\\/i)) {
      // Windows root — can't go higher from C:\
    } else {
      browseDir('/');
    }
  });

  $('fbGo').addEventListener('click', () => {
    const val = $('fbPathInput').value.trim();
    if (val) browseDir(val);
  });

  $('fbPathInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = $('fbPathInput').value.trim();
      if (val) browseDir(val);
    }
  });
}

// ─── Navbar Action Buttons ────────────────────────────────────────────────────
function initNavActions() {
  $('recBadge').addEventListener('click',     () => send({ type: 'toggle_recording' }));
  $('btnToggleRec').addEventListener('click', () => send({ type: 'toggle_recording' }));
  $('btnExport').addEventListener('click',    () => exportHAR());
  $('btnClear').addEventListener('click',     () => {
    if (confirm('Clear all captured requests?')) send({ type: 'clear' });
  });
  $('btnSetup').addEventListener('click', openSetupModal);
}

// ─── Setup Modal ──────────────────────────────────────────────────────────────
function openSetupModal() {
  const overlay = $('setupOverlay');
  overlay.classList.remove('hidden');

  // Fill dynamic URLs with actual IP
  const ip = S.ips[0] || location.hostname;
  const certUrl = `http://${ip}:${S.proxyPort === 8888 ? 8000 : S.proxyPort + 1}/ca.crt`;
  const dashUrl = `http://${ip}:8000`;

  $('iosUrl').textContent     = `${dashUrl}/ca.crt`;
  $('androidUrl').textContent = `${dashUrl}/ca.crt`;
  $('caCertLink').href        = `${dashUrl}/ca.crt`;

  $('copyCaUrl').onclick = () => copyText(`${dashUrl}/ca.crt`, $('copyCaUrl'));
}

function initSetupModal() {
  $('setupClose').addEventListener('click', () => $('setupOverlay').classList.add('hidden'));
  $('setupOverlay').addEventListener('click', e => {
    if (e.target === $('setupOverlay')) $('setupOverlay').classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $('setupOverlay').classList.add('hidden');
  });
}

// ─── Utility: DOM ─────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : (str || '');
}

// ─── Utility: Formatting ──────────────────────────────────────────────────────
function fmtBytes(n) {
  if (!n || n === 0) return '—';
  if (n < 1024)      return n + ' B';
  if (n < 1048576)   return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtDur(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function statusClass(status) {
  if (!status || status === 0) return 's-0xx';
  if (status < 300) return 's-2xx';
  if (status < 400) return 's-3xx';
  if (status < 500) return 's-4xx';
  return 's-5xx';
}

function durClass(ms) {
  if (!ms) return 'dur-mid';
  if (ms < 200)  return 'dur-fast';
  if (ms < 1000) return 'dur-mid';
  return 'dur-slow';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function init() {
  initViewTabs();
  initDetailTabs();
  initFilter();
  initNavActions();
  initToolsDropdown();
  initSslModal();
  initMlModal();
  initFileBrowser();
  initSetupModal();
  initResize();
  initKeyboard();
  showEmptyState();
  connect();
}

init();
