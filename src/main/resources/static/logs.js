'use strict';
/* Pod log viewer (drawer at the bottom of the canvas). Depends on app.js globals: $, esc, store, state, podsFor. */
/* ================= pod logs ================= */
const LOG_MAX = 20000;
const LOG_KINDS = ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'];
const logs = { es: null, ns: null, pod: null, pods: [], lines: [], filter: '', stick: true, unseen: 0, auto: false, multi: false };
const ALL_PODS = '__all';
const POD_COLORS = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#22d3ee', '#fb923c', '#a3e635'];
try { const h = parseInt(store.get('logsH')); if (h > 100) document.querySelector('.canvas').style.setProperty('--logs-h', h + 'px'); } catch {}

/* pods to offer for a node: a pod itself + its siblings, or every pod a workload owns (via ownerReference edges) */
function podsFor(id) {
  if (!state.graph) return [];
  const byId = new Map(state.graph.nodes.map(n => [n.id, n]));
  const node = byId.get(id); if (!node || !LOG_KINDS.includes(node.kind)) return [];
  const owned = new Map();
  state.graph.edges.forEach(e => { if (e.type === 'owns') (owned.get(e.source) || owned.set(e.source, []).get(e.source)).push(e.target); });
  const under = root => { const out = [], q = [root], seen = new Set(); while (q.length) { const x = q.shift(); if (seen.has(x)) continue; seen.add(x);
    const n = byId.get(x); if (n?.kind === 'Pod') out.push(n); (owned.get(x) || []).forEach(c => q.push(c)); } return out; };
  if (node.kind === 'Pod') {
    const owner = state.graph.edges.find(e => e.type === 'owns' && e.target === id);
    const sib = owner ? under(owner.source) : [node];
    return sib.length ? sib : [node];
  }
  return under(id);
}

function logActions(n) {
  const pods = podsFor(n.id);
  if (!pods.length) return '';
  const label = n.kind === 'Pod' ? 'Xem log' : `Xem log pod <small>(${pods.length})</small>`;
  return `<div class="actions"><button class="btn primary" id="openLogs"><svg class="i" viewBox="0 0 24 24"><path d="M4 17l6-6-6-6M12 19h8"/></svg>${label}</button></div>`;
}

function openLogsFor(id) {
  const pods = podsFor(id); if (!pods.length) return;
  const node = state.graph.nodes.find(n => n.id === id);
  // a pod: that pod. A workload with several pods: all of them in one stream
  const pick = node.kind === 'Pod' ? node.name : pods.length > 1 ? ALL_PODS : pods[0].name;
  logs.pods = pods;
  $('logPod').innerHTML = (pods.length > 1 ? `<option value="${ALL_PODS}">Tất cả pod (${pods.length})</option>` : '')
    + pods.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.health !== 'ok' ? ' · ' + esc(p.status) : ''}</option>`).join('');
  $('logPodWrap').hidden = pods.length < 2;
  openLogs(pods[0].namespace, pick);
}

async function openLogs(ns, pod) {
  stopLogs();
  if (typeof closeTerminal === 'function') closeTerminal(); // one drawer at a time
  logs.ns = ns; logs.pod = pod; logs.multi = pod === ALL_PODS;
  $('logPod').value = pod;
  $('logPodName').textContent = logs.pods.length > 1 ? 'Log' : pod;
  if (logs.multi) pod = logs.pods[0].name; // container list of the first pod (pods of one workload share containers)
  $('logPodName').title = pod;
  $('logs').hidden = false; document.querySelector('.canvas').classList.add('with-logs');
  logMessage('Đang tải danh sách container…');
  let cs;
  try {
    const r = await fetch(`/api/pods/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}/containers`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    cs = body;
  } catch (e) { logMessage('Không lấy được thông tin pod', e.message, true); logStatus('Lỗi', 'err'); return; }
  if (logs.pod !== (logs.multi ? ALL_PODS : pod)) return; // user switched pod meanwhile
  $('logContainer').innerHTML = cs.map(c => {
    const st = c.state === 'running' ? '' : ` · ${c.reason || c.state}`;
    return `<option value="${esc(c.name)}">${c.init ? 'init: ' : ''}${esc(c.name)}${esc(st)}${c.restarts ? ` · ↻${c.restarts}` : ''}</option>`;
  }).join('');
  logs.containers = cs;
  const main = cs.find(c => !c.init) || cs[0];
  if (main) $('logContainer').value = main.name;
  autoPrevious();
  startLogs();
}

/* a crash-looping container has nothing (or almost nothing) in its current log — the crash reason is in the previous run */
function autoPrevious() {
  const c = (logs.containers || []).find(x => x.name === $('logContainer').value);
  const want = !!(c && c.hasPrevious && c.state !== 'running');
  if (want !== $('logPrev').classList.contains('on')) $('logPrev').classList.toggle('on', want);
  logs.auto = want;
}

function stopLogs() { if (logs.es) { logs.es.close(); logs.es = null; } }

function startLogs() {
  stopLogs();
  logs.lines = []; logs.unseen = 0; logs.stick = true; $('logJump').hidden = true;
  $('logBody').innerHTML = '';
  const prev = $('logPrev').classList.contains('on');
  const follow = $('logFollow').classList.contains('on') && !prev;
  $('logFollow').disabled = prev;
  // several pods: always ask for timestamps so the first burst of each pod can be merged in time order
  const qs = new URLSearchParams({ container: $('logContainer').value, tail: $('logTail').value,
    timestamps: logs.multi || $('logTs').classList.contains('on'), previous: prev, follow });
  logStatus('Đang kết nối…', '');
  updateLogCount();
  let url;
  if (logs.multi) {
    logs.pods.forEach(p => qs.append('pods', p.name));
    url = `/api/logs/multi?namespace=${encodeURIComponent(logs.ns)}&` + qs;
  } else url = `/api/pods/${encodeURIComponent(logs.ns)}/${encodeURIComponent(logs.pod)}/logs?` + qs;
  const es = logs.es = new EventSource(url);
  let got = false, buffer = [], bufferUntil = Date.now() + 700, flushTimer = null;
  const tsOf = it => { const m = TS_RE.exec(typeof it === 'string' ? it : it.l); return m ? m[1] : ''; };
  const flushBuffer = () => { flushTimer = null; const b = buffer; buffer = []; b.sort((x, y) => tsOf(x).localeCompare(tsOf(y))); appendLines(b); };
  es.addEventListener('lines', e => {
    if (!got) { got = true; logStatus(follow ? (logs.multi ? `Đang theo dõi ${logs.pods.length} pod` : 'Đang theo dõi') : 'Đang tải…', follow ? 'on' : ''); }
    const batch = JSON.parse(e.data);
    if (logs.multi && Date.now() < bufferUntil) { buffer.push(...batch); if (!flushTimer) flushTimer = setTimeout(flushBuffer, bufferUntil - Date.now()); return; }
    if (buffer.length) flushBuffer();
    appendLines(batch);
  });
  es.addEventListener('end', e => {
    es.close(); if (logs.es === es) logs.es = null;
    const msg = JSON.parse(e.data).message;
    logStatus(msg + (logs.auto ? ' · tự bật "Lần chạy trước" vì container đang lỗi' : ''), '');
    if (!logs.lines.length) logMessage('Không có dòng log nào', prev ? 'Container chưa có lần chạy trước nào có log.' : 'Container chưa ghi gì ra stdout/stderr.');
  });
  es.addEventListener('error', e => {
    es.close(); if (logs.es === es) logs.es = null;
    if (e.data) { const m = JSON.parse(e.data).message; logStatus('Lỗi', 'err'); if (!logs.lines.length) logMessage('Không đọc được log', m, true); else logStatus(m, 'err'); }
    else logStatus('Mất kết nối tới server — bấm một tuỳ chọn bất kỳ để thử lại', 'err');
  });
  es.addEventListener('open', () => { if (!got) logStatus(follow ? 'Đang theo dõi' : 'Đang tải…', follow ? 'on' : ''); });
}

function logMessage(title, sub, err) {
  $('logBody').innerHTML = `<div class="logs-msg${err ? ' err' : ''}">${esc(title)}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}
function logStatus(text, cls) { $('logFoot').className = 'logs-foot' + (cls ? ' ' + cls : ''); $('logStatus').textContent = text; }
function updateLogCount() {
  const shown = logs.filter ? $('logBody').querySelectorAll('.ll').length : logs.lines.length;
  $('logCount').textContent = logs.filter ? `${shown} / ${logs.lines.length} dòng` : `${logs.lines.length} dòng`;
}

const TS_RE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/s;
/* a log line is a string (one pod) or {p: pod index, l: line, sys?} (several pods) */
const lineText = it => (typeof it === 'string' ? it : it.l);
const podOf = it => (typeof it === 'string' ? null : logs.pods[it.p]);
function matchesFilter(it, q) {
  if (!q) return true;
  const p = podOf(it);
  return lineText(it).toLowerCase().includes(q) || (p && p.name.toLowerCase().includes(q));
}
function lineEl(item, no) {
  const text = lineText(item), pod = podOf(item);
  const div = document.createElement('div');
  let ts = '', body = text;
  const m = TS_RE.exec(text);
  if (m) { body = m[2]; if ($('logTs').classList.contains('on')) ts = m[1]; }
  if (/\b(ERROR|ERR|FATAL|PANIC|CRITICAL|Exception|Traceback)\b/i.test(body)) div.className = 'll e';
  else if (/\b(WARN|WARNING)\b/i.test(body)) div.className = 'll w';
  else if (/\b(DEBUG|TRACE)\b/.test(body)) div.className = 'll d';
  else div.className = 'll';
  let tx = esc(body);
  if (logs.filter) {
    const q = logs.filter.toLowerCase(), lo = body.toLowerCase(); let out = '', i = 0, j;
    while ((j = lo.indexOf(q, i)) !== -1) { out += esc(body.slice(i, j)) + '<mark>' + esc(body.slice(j, j + q.length)) + '</mark>'; i = j + q.length; }
    tx = out + esc(body.slice(i));
  }
  const tsHtml = ts ? `<span class="ts" title="${ts}">${new Date(ts).toLocaleTimeString('vi-VN', { hour12: false })}.${ts.slice(20, 23)}</span>` : '';
  const tag = pod ? `<span class="pt" style="--c:${POD_COLORS[item.p % POD_COLORS.length]}" title="${esc(pod.name)}">${esc(pod.name.slice(-5))}</span>` : '';
  if (item && item.sys) div.className = 'll sys';
  div.innerHTML = `<span class="ln">${no}</span><span class="tx">${tag}${tsHtml}${tx}</span>`;
  return div;
}

function appendLines(batch) {
  const body = $('logBody');
  if (!logs.lines.length) body.innerHTML = '';
  const start = logs.lines.length;
  logs.lines.push(...batch);
  const frag = document.createDocumentFragment(); let added = 0;
  const q = logs.filter.toLowerCase();
  batch.forEach((t, i) => { if (matchesFilter(t, q)) { frag.appendChild(lineEl(t, start + i + 1)); added++; } });
  body.appendChild(frag);
  if (logs.lines.length > LOG_MAX) { // keep memory/DOM bounded
    const drop = logs.lines.length - LOG_MAX;
    logs.lines.splice(0, drop);
    if (!q) for (let i = 0; i < drop && body.firstChild; i++) body.firstChild.remove();
  }
  if (logs.stick) body.scrollTop = body.scrollHeight;
  else if (added) { logs.unseen += added; $('logJump').hidden = false; $('logJump').querySelector('span').textContent = logs.unseen; }
  updateLogCount();
}

function rerenderLogs() {
  const body = $('logBody'); body.innerHTML = '';
  const q = logs.filter.toLowerCase(), frag = document.createDocumentFragment();
  // line numbers stay those of the full stream
  const offset = 1;
  logs.lines.forEach((t, i) => { if (matchesFilter(t, q)) frag.appendChild(lineEl(t, i + offset)); });
  body.appendChild(frag);
  if (!body.children.length && logs.lines.length) logMessage('Không có dòng nào khớp bộ lọc', `"${logs.filter}"`);
  body.scrollTop = body.scrollHeight; logs.stick = true; logs.unseen = 0; $('logJump').hidden = true;
  updateLogCount();
}

function closeLogs() {
  stopLogs(); $('logs').hidden = true;
  document.querySelector('.canvas').classList.remove('with-logs', 'logs-max'); $('logs').classList.remove('max');
}

$('logBody').addEventListener('scroll', () => {
  const b = $('logBody');
  logs.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
  if (logs.stick) { logs.unseen = 0; $('logJump').hidden = true; }
});
$('logJump').onclick = () => { const b = $('logBody'); b.scrollTop = b.scrollHeight; };
$('logPod').onchange = () => openLogs(logs.ns, $('logPod').value);
$('logContainer').onchange = () => { autoPrevious(); startLogs(); };
$('logTail').onchange = startLogs;
['logFollow', 'logTs', 'logPrev'].forEach(id => $(id).onclick = () => {
  if ($(id).disabled) return; $(id).classList.toggle('on'); if (id === 'logPrev') logs.auto = false; startLogs(); });
$('logWrap').onclick = () => { $('logWrap').classList.toggle('on'); $('logBody').classList.toggle('nowrap', !$('logWrap').classList.contains('on')); };
let logQTimer;
$('logQ').addEventListener('input', e => { clearTimeout(logQTimer); logQTimer = setTimeout(() => { logs.filter = e.target.value.trim(); rerenderLogs(); }, 150); });
$('logClear').onclick = () => { logs.lines = []; $('logBody').innerHTML = ''; updateLogCount(); };
$('logDownload').onclick = () => {
  const a = document.createElement('a');
  const text = logs.lines.map(it => (podOf(it) ? `[${podOf(it).name}] ` : '') + lineText(it)).join('\n');
  a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
  a.download = `${logs.multi ? logs.pods[0].name.replace(/-[a-z0-9]+-[a-z0-9]+$/, '') + '_all-pods' : logs.pod}_${$('logContainer').value}${$('logPrev').classList.contains('on') ? '_previous' : ''}.log`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('logMax').onclick = () => { $('logs').classList.toggle('max'); document.querySelector('.canvas').classList.toggle('logs-max', $('logs').classList.contains('max')); };
$('logClose').onclick = closeLogs;
$('logsResize').addEventListener('pointerdown', e => {
  const canvas = document.querySelector('.canvas'), rect = canvas.getBoundingClientRect();
  $('logs').classList.remove('max'); canvas.classList.remove('logs-max');
  const move = ev => { const h = Math.max(140, Math.min(rect.height - 40, rect.bottom - ev.clientY)); canvas.style.setProperty('--logs-h', h + 'px'); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    store.set('logsH', parseInt(getComputedStyle(canvas).getPropertyValue('--logs-h'))); };
  addEventListener('pointermove', move); addEventListener('pointerup', up); e.preventDefault();
});

