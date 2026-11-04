'use strict';
/*
 * Events timeline: a second view over the canvas. One row per object that has events, warnings first, then by latest
 * activity; a density strip (Normal / Warning) over a shared time axis; repeated events drawn as a span from first to
 * last occurrence. Click a row (or a mark) to open that object in the detail panel on its Events tab.
 * Depends on app.js globals: $, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw.
 */
const tl = { open: false, range: +(store.get('tl.range') || 3600), type: store.get('tl.type') || 'all', q: '', data: null, timer: null, now: 0 };
const TL_RANGES = [[900, '15 phút'], [3600, '1 giờ'], [10800, '3 giờ'], [0, 'Tất cả']];
const TL_BUCKETS = 72;

$('timeline').innerHTML = `
  <div class="tl-bar">
    <div class="seg" role="group" aria-label="Khoảng thời gian">${TL_RANGES.map(([s, l]) => `<button data-range="${s}">${l}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Loại event">
      <button data-type="all">Tất cả</button><button data-type="Warning"><i class="dot warn"></i>Chỉ Warning</button>
    </div>
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="tlQ" type="search" placeholder="Lọc theo tên, reason, message…" autocomplete="off" aria-label="Lọc event"></div>
    <span class="tl-sum" id="tlSum"></span>
    <div class="spacer"></div>
    <button class="icon-btn sm" id="tlClose" title="Đóng timeline (về đồ thị)" aria-label="Đóng timeline"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="tl-head"><div class="tl-lab">Mật độ</div><div class="tl-lane" id="tlDensity"></div></div>
  <div class="tl-head axis"><div class="tl-lab"></div><div class="tl-lane" id="tlAxis"></div></div>
  <div class="tl-rows" id="tlRows"></div>
  <div class="tl-tip" id="tlTip" hidden></div>`;

function tlWindow() {
  const evs = tl.data?.events || [];
  const end = tl.now;
  let start = tl.range ? end - tl.range * 1000 : Math.min(end - 15 * 60 * 1000, ...evs.map(e => e.first));
  return { start, end, span: Math.max(1, end - start) };
}

function tlFiltered() {
  const { start } = tlWindow();
  const q = tl.q.toLowerCase();
  return (tl.data?.events || []).filter(e => e.last >= start
    && (tl.type === 'all' || e.type === tl.type)
    && (!q || [e.name, e.kind, e.namespace, e.reason, e.message].some(x => (x || '').toLowerCase().includes(q))));
}

const tlAgo = ms => {
  const s = Math.max(0, Math.round((tl.now - ms) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' + (s % 60 && s < 600 ? (s % 60) + 's' : '') : Math.floor(s / 3600) + 'h' + (Math.floor(s / 60) % 60 ? (Math.floor(s / 60) % 60) + 'm' : '');
};
const tlClock = ms => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

function renderTimeline() {
  if (!tl.open || !tl.data) return;
  document.querySelectorAll('#timeline [data-range]').forEach(b => b.classList.toggle('on', +b.dataset.range === tl.range));
  document.querySelectorAll('#timeline [data-type]').forEach(b => b.classList.toggle('on', b.dataset.type === tl.type));
  const W = Math.max(200, $('tlAxis').clientWidth);
  const { start, span } = tlWindow();
  const x = t => Math.max(0, Math.min(W, (t - start) / span * W));
  const evs = tlFiltered();

  // density: occurrences spread over [first, last]
  const bucket = span / TL_BUCKETS, normal = new Array(TL_BUCKETS).fill(0), warn = new Array(TL_BUCKETS).fill(0);
  evs.forEach(e => {
    const a = Math.max(0, Math.floor((Math.max(e.first, start) - start) / bucket)), b = Math.min(TL_BUCKETS - 1, Math.floor((e.last - start) / bucket));
    const n = Math.max(0, b - a + 1), per = e.count / Math.max(1, Math.ceil((e.last - e.first) / bucket) + 1);
    for (let i = a; i <= b && n; i++) (e.type === 'Warning' ? warn : normal)[i] += per;
  });
  const peak = Math.max(1, ...normal.map((v, i) => v + warn[i]));
  const bw = W / TL_BUCKETS, H = 34;
  $('tlDensity').innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Mật độ event theo thời gian">${normal.map((v, i) => {
    const hn = v / peak * (H - 2), hw = warn[i] / peak * (H - 2);
    return (hn ? `<rect x="${i * bw + 0.5}" y="${H - hn}" width="${Math.max(1, bw - 1)}" height="${hn}" class="d-n"/>` : '')
      + (hw ? `<rect x="${i * bw + 0.5}" y="${H - hn - hw}" width="${Math.max(1, bw - 1)}" height="${hw}" class="d-w"/>` : '');
  }).join('')}</svg>`;

  // axis ticks
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 21600].map(s => s * 1000);
  const step = steps.find(s => span / s <= 8) || steps[steps.length - 1];
  let ticks = '';
  for (let t = Math.ceil(start / step) * step; t <= tl.now; t += step)
    ticks += `<g transform="translate(${x(t)},0)"><line y1="14" y2="20" class="tick"/><text y="11" text-anchor="middle">${tlClock(t)}</text></g>`;
  $('tlAxis').innerHTML = `<svg width="${W}" height="20">${ticks}<line x1="${W - 0.5}" x2="${W - 0.5}" y1="0" y2="20" class="now"/></svg>`;

  // rows: one per object
  const rows = new Map();
  evs.forEach(e => { const r = rows.get(e.objectId) || rows.set(e.objectId, { id: e.objectId, kind: e.kind, ns: e.namespace, name: e.name, evs: [], warn: 0, last: 0 }).get(e.objectId);
    r.evs.push(e); if (e.type === 'Warning') r.warn += e.count; r.last = Math.max(r.last, e.last); });
  const list = [...rows.values()].sort((a, b) => (b.warn > 0) - (a.warn > 0) || b.last - a.last);
  const total = evs.reduce((s, e) => s + e.count, 0), warnTotal = evs.filter(e => e.type === 'Warning').reduce((s, e) => s + e.count, 0);
  $('tlSum').innerHTML = `<b>${total}</b> event · <b class="w">${warnTotal}</b> warning · ${list.length} tài nguyên`;
  if (!list.length) {
    $('tlRows').innerHTML = `<div class="tl-empty">Không có event nào ${tl.range ? 'trong khoảng thời gian này' : ''}${tl.q || tl.type !== 'all' ? ' khớp bộ lọc' : ''}.
      <div class="muted">API server chỉ giữ event khoảng 1 giờ (mặc định <code>--event-ttl</code>).</div></div>`;
    return;
  }
  const byId = new Map((state.graph?.nodes || []).map(n => [n.id, n]));
  const RH = 26;
  $('tlRows').innerHTML = list.map(r => {
    const n = byId.get(r.id) || { kind: r.kind, name: r.name };
    const marks = r.evs.map((e, i) => {
      const cls = e.type === 'Warning' ? 'w' : 'n', x1 = x(Math.max(e.first, start)), x2 = x(e.last);
      const span = e.count > 1 && x2 - x1 > 2 ? `<line x1="${x1}" x2="${x2}" y1="${RH / 2}" y2="${RH / 2}" class="sp ${cls}"/>` : '';
      return `${span}<circle cx="${x2}" cy="${RH / 2}" r="${e.count > 1 ? 5 : 4}" class="mk ${cls}" data-i="${i}"/>`;
    }).join('');
    return `<div class="tl-row ${state.selected === r.id ? 'sel' : ''}" data-id="${esc(r.id)}">
      <div class="tl-lab" title="${esc(r.kind + ' ' + (r.ns ? r.ns + '/' : '') + r.name)}">
        <span class="k" style="--c:${kindInfo(n).color}">${icon(iconKind(n))}</span>
        <span class="nm">${esc(r.name)}</span>${isAll() && r.ns ? `<span class="ns">${esc(r.ns)}</span>` : ''}
        ${r.warn ? `<span class="wc" title="${r.warn} warning">${r.warn}</span>` : ''}
      </div>
      <div class="tl-lane"><svg width="${W}" height="${RH}">${marks}</svg></div>
    </div>`;
  }).join('');
  tl.rows = list;
}

async function loadTimeline() {
  try {
    const r = await fetch('/api/events?namespace=' + encodeURIComponent(currentNs()));
    if (!r.ok) throw new Error(r.statusText);
    tl.data = await r.json();
    tl.now = tl.data.now;
    renderTimeline();
  } catch (e) {
    $('tlRows').innerHTML = `<div class="tl-empty">Không tải được event: ${esc(e.message)}</div>`;
  }
}

function setTimeline(open) {
  tl.open = open;
  if (open && typeof setHelm === 'function' && hm.open) setHelm(false);
  $('timeline').hidden = !open;
  $('tlBtn').classList.toggle('on', open);
  $('tlBtn').setAttribute('aria-pressed', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'timeline'); else if (u.searchParams.get('view') === 'timeline') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearInterval(tl.timer);
  if (open) { loadTimeline(); tl.timer = setInterval(loadTimeline, 5000); }
}

$('tlBtn').onclick = () => setTimeline(!tl.open);
$('tlClose').onclick = () => setTimeline(false);
$('timeline').addEventListener('click', e => {
  const rb = e.target.closest('[data-range]');
  if (rb) { tl.range = +rb.dataset.range; store.set('tl.range', String(tl.range)); renderTimeline(); return; }
  const tb = e.target.closest('[data-type]');
  if (tb) { tl.type = tb.dataset.type; store.set('tl.type', tl.type); renderTimeline(); return; }
  const row = e.target.closest('.tl-row');
  if (row) {
    const n = state.graph?.nodes.find(x => x.id === row.dataset.id);
    if (!n) return;
    if (e.target.closest('.mk')) { state.tab = 'events'; store.set('tab', 'events'); }
    showDetailRaw(n);
    document.querySelectorAll('.tl-row.sel').forEach(r => r.classList.remove('sel'));
    row.classList.add('sel');
  }
});
$('tlQ').addEventListener('input', e => { tl.q = e.target.value.trim(); renderTimeline(); });

/* tooltip on marks */
$('tlRows').addEventListener('mousemove', e => {
  const mk = e.target.closest('.mk'), tip = $('tlTip');
  if (!mk) { tip.hidden = true; return; }
  const row = tl.rows?.find(r => r.id === mk.closest('.tl-row').dataset.id), ev = row?.evs[+mk.dataset.i];
  if (!ev) { tip.hidden = true; return; }
  tip.innerHTML = `<div class="h"><span class="ty ${ev.type === 'Warning' ? 'w' : ''}">${esc(ev.type)}</span><b>${esc(ev.reason)}</b>
      <span class="muted">${ev.count > 1 ? `x${ev.count} · ${tlAgo(ev.first)} → ${tlAgo(ev.last)} trước` : tlAgo(ev.last) + ' trước'}</span></div>
    <div class="m">${ev.fieldPath ? `<code>${esc(ev.fieldPath)}</code> ` : ''}${esc(ev.message)}</div>
    <div class="muted">${esc(ev.source)} · ${esc(ev.kind)} ${esc(ev.namespace ? ev.namespace + '/' : '')}${esc(ev.name)}</div>`;
  tip.hidden = false;
  const box = $('timeline').getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = e.clientX - box.left + 14, top = e.clientY - box.top + 14;
  if (left + tw > box.width - 8) left = e.clientX - box.left - tw - 14;
  if (top + th > box.height - 8) top = e.clientY - box.top - th - 10;
  tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
});
$('tlRows').addEventListener('mouseleave', () => { $('tlTip').hidden = true; });
new ResizeObserver(() => renderTimeline()).observe($('timeline'));
$('ns').addEventListener('change', () => { if (tl.open) loadTimeline(); });
if (new URLSearchParams(location.search).get('view') === 'timeline') setTimeline(true);
