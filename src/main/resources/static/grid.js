'use strict';
/*
 * Grid view: one table at a time — the kind picked in the tabs (remembered; ":po", ":svc"… switch it).
 * Each kind has its own columns. Toolbar: search inside the table (any column), page size, pagination; click a column
 * header to sort (default: newest first). Click / Enter opens the detail panel; j / k move the cursor within the page.
 * The graph's filter bar is hidden while the grid is open; the top-bar search and health chips still narrow the rows.
 * Depends on app.js ($, esc, state, store, icon, iconKind, kindInfo, isAll, age, H, showDetailRaw, matchesQuery,
 * nodeCardWanted, currentNs, render), nodes.js (shortNode) and VIEWS.
 */
const gv = { open: false, sort: store.get('grid2.sort') || 'age', dir: +(store.get('grid2.dir') || 1), cursor: 0, rows: [],
  kind: store.get('grid2.kind') || 'Pod', q: '', page: 0, size: +(store.get('grid2.size') || 50) };
const HEALTH_ORDER = { error: 0, warn: 1, unknown: 2, ok: 3 };
const RES = [['cpu', 'CPU'], ['memory', 'Memory']];
const KIND_COLS = {
  Pod: [['restarts', 'Restarts'], ['node', 'Node'], ['podIP', 'IP'], ['qos', 'QoS'], ...RES],
  Deployment: [['replicas', 'Ready'], ['updated', 'Up-to-date'], ['strategy', 'Strategy'], ['images', 'Image'], ...RES],
  StatefulSet: [['replicas', 'Ready'], ['serviceName', 'Service'], ['images', 'Image'], ...RES],
  DaemonSet: [['ready', 'Ready'], ['images', 'Image'], ...RES],
  ReplicaSet: [['images', 'Image'], ...RES],
  Job: [['succeeded', 'Succeeded'], ['failed', 'Failed'], ['completed', 'Hoàn thành']],
  CronJob: [['schedule', 'Lịch'], ['active', 'Đang chạy'], ['lastSchedule', 'Chạy gần nhất'], ['lastSuccess', 'Thành công gần nhất']],
  Service: [['type', 'Type'], ['clusterIP', 'Cluster IP'], ['ports', 'Ports'], ['endpoints', 'Endpoints'], ['selector', 'Selector']],
  Ingress: [['hosts', 'Hosts'], ['class', 'Class'], ['address', 'Address'], ['tls', 'TLS']],
  IngressClass: [['controller', 'Controller']],
  HorizontalPodAutoscaler: [['replicas', 'Replicas'], ['desired', 'Desired'], ...RES],
  PodDisruptionBudget: [['minAvailable', 'Min available'], ['maxUnavailable', 'Max unavailable'], ['pods', 'Pods']],
  NetworkPolicy: [['policyTypes', 'Types'], ['pods', 'Pods'], ['ingressRules', 'Ingress rules'], ['egressRules', 'Egress rules']],
  PersistentVolumeClaim: [['storageClass', 'StorageClass'], ['request', 'Request'], ['capacity', 'Capacity'], ['accessModes', 'Access']],
  PersistentVolume: [['capacity', 'Capacity'], ['reclaimPolicy', 'Reclaim'], ['claim', 'Claim']],
  StorageClass: [['provisioner', 'Provisioner'], ['reclaimPolicy', 'Reclaim'], ['bindingMode', 'Binding']],
  ConfigMap: [['keys', 'Keys']],
  Secret: [['type', 'Type'], ['keys', 'Keys']],
  ServiceAccount: [['automountToken', 'Automount token'], ['imagePullSecrets', 'Pull secrets']],
  Role: [['rules', 'Rules']], ClusterRole: [['rules', 'Rules']],
  RoleBinding: [['subjects', 'Subjects']], ClusterRoleBinding: [['subjects', 'Subjects']],
  Node: [['roles', 'Roles'], ['internalIP', 'IP'], ['kubelet', 'Kubelet'], ...RES],
};
const CUSTOM_COLS = [['apiVersion', 'API']];
const NUM_COLS = new Set(['cpu', 'memory', 'restarts', 'succeeded', 'failed']);
/* tab order: traffic → workloads → pods → policies → storage → config → access → cluster; custom kinds last */
const GRID_ORDER = ['Ingress', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'Pod',
  'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy', 'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass',
  'ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'IngressClass', 'Node'];

$('grid').innerHTML = `
  <div class="gv-tabs" id="gvTabs" role="tablist" aria-label="Loại tài nguyên"></div>
  <div class="gv-bar">
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="gvQ" type="search" placeholder="Tìm trong bảng…" autocomplete="off" aria-label="Tìm trong bảng"></div>
    <span class="gv-count" id="gvCount"></span>
    <div class="spacer"></div>
    <label class="gv-size">Mỗi trang <select id="gvSize" aria-label="Số dòng mỗi trang">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
    <nav class="gv-pages" id="gvPages" aria-label="Phân trang"></nav>
  </div>
  <div class="gv-wrap" tabindex="0" id="gvWrap" aria-label="Bảng tài nguyên"></div>
  <div class="gv-foot" id="gvFoot"><kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở · <kbd>d</kbd> describe · <kbd>y</kbd> YAML · <kbd>l</kbd> log · <kbd>[</kbd>/<kbd>]</kbd> trang trước/sau · <kbd>:</kbd> lệnh · <kbd>?</kbd> phím tắt</div>`;
$('gvSize').value = String(gv.size);

const gkey = n => (n.group ? n.group + '/' + n.kind : n.kind); // custom kinds of different API groups stay apart
const numVal = s => { const m = /^(-?[\d.]+)\s*(m|Ki|Mi|Gi|k|M|G)?/.exec(s || ''); if (!m) return null;
  const f = { m: 0.001, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2]] || 1; return +m[1] * f; };
const cellText = (n, k) => { const v = n.info?.[k]; return k === 'node' && v && typeof shortNode === 'function' ? shortNode(v) : v ?? ''; };

function sortKey(c) {
  return {
    health: n => HEALTH_ORDER[n.health] ?? 9, name: n => n.name.toLowerCase(), namespace: n => n.namespace || '', status: n => n.status || '',
    age: n => -(Date.parse(n.created) || 0), // ascending = newest first
  }[c] || (n => { const t = cellText(n, c); const v = numVal(t); return v ?? String(t).toLowerCase(); });
}

function renderGrid() {
  if (!gv.open || !state.graph) return;
  const q = state.query.toLowerCase();
  const all = (state.graph.nodes || []).filter(n => (n.kind !== 'Node' || nodeCardWanted(n)) && matchesQuery(n, q) && (!state.health || n.health === state.health));
  const groups = new Map();
  all.forEach(n => (groups.get(gkey(n)) || groups.set(gkey(n), []).get(gkey(n))).push(n));
  const rank = n => (n.group ? 1000 : GRID_ORDER.indexOf(n.kind) >= 0 ? GRID_ORDER.indexOf(n.kind) : 500);
  const order = [...groups.keys()].sort((a, b) => rank(groups.get(a)[0]) - rank(groups.get(b)[0]) || a.localeCompare(b));
  // the chosen kind (by section key, or by plain kind from ":po"); fall back to Pod / the first kind of the view
  let tab = groups.has(gv.kind) ? gv.kind : order.find(k => groups.get(k)[0].kind === gv.kind);
  if (!tab) tab = order.includes('Pod') ? 'Pod' : order[0];
  $('gvTabs').innerHTML = order.map(k => {
    const n0 = groups.get(k)[0], bad = groups.get(k).filter(n => n.health === 'error').length;
    return `<button role="tab" data-gtab="${esc(k)}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}" style="--c:${kindInfo(n0).color}"
      title="${esc(kindInfo(n0).label)}${n0.group ? ' · ' + esc(n0.group) : ''}${bad ? ` · ${bad} lỗi` : ''}">${icon(iconKind(n0))}${esc(kindInfo(n0).label)}<span class="n">${groups.get(k).length}</span>${bad ? '<i class="bad"></i>' : ''}</button>`;
  }).join('') || '<span class="muted">Không có tài nguyên nào.</span>';
  if (!tab) { $('gvWrap').innerHTML = `<div class="tl-empty">Không có tài nguyên nào khớp bộ lọc.</div>`; $('gvPages').innerHTML = ''; $('gvCount').textContent = ''; gv.rows = []; return; }

  const n0 = groups.get(tab)[0];
  const cols = n0.group ? CUSTOM_COLS : KIND_COLS[n0.kind] || CUSTOM_COLS;
  // search inside the table: name, namespace, status, reason and every column of this kind
  const tq = gv.q.toLowerCase();
  const rows = groups.get(tab).filter(n => !tq || [n.name, n.namespace, n.status, n.reason, ...cols.map(([c]) => cellText(n, c))]
    .some(x => String(x ?? '').toLowerCase().includes(tq)));
  if (!['health', 'name', 'namespace', 'status', 'age', ...cols.map(c => c[0])].includes(gv.sort)) { gv.sort = 'age'; gv.dir = 1; }
  const key = sortKey(gv.sort);
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * gv.dir; });

  const pages = Math.max(1, Math.ceil(rows.length / gv.size));
  const selAt = rows.findIndex(n => n.id === state.selected);
  if (gv.followSel && selAt >= 0) gv.page = Math.floor(selAt / gv.size);
  gv.followSel = false;
  gv.page = Math.min(gv.page, pages - 1);
  const page = rows.slice(gv.page * gv.size, (gv.page + 1) * gv.size);
  gv.rows = page;
  $('gvCount').innerHTML = rows.length === groups.get(tab).length
    ? `<b>${rows.length}</b> ${esc(kindInfo(n0).label)}`
    : `<b>${rows.length}</b> / ${groups.get(tab).length} ${esc(kindInfo(n0).label)} khớp “${esc(gv.q)}”`;

  const sortIcon = c => (gv.sort === c ? `<svg class="i so" viewBox="0 0 24 24"><path d="${gv.dir > 0 ? 'M7 14l5-5 5 5' : 'M7 10l5 5 5-5'}"/></svg>` : '<svg class="i so idle" viewBox="0 0 24 24"><path d="M8 10l4-4 4 4M8 14l4 4 4-4"/></svg>');
  const th = (c, l, cls = '') => `<th data-sort="${c}" class="${cls} ${gv.sort === c ? 'on' : ''}" aria-sort="${gv.sort === c ? (gv.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="Sắp xếp theo ${esc(l || 'tình trạng')}"><span>${l}${sortIcon(c)}</span></th>`;
  const ageTitle = gv.sort === 'age' ? (gv.dir > 0 ? 'mới nhất trước' : 'cũ nhất trước') : '';
  $('gvWrap').innerHTML = page.length ? `<table class="gv-t">
    <thead><tr>${th('health', '', 'hc')}${th('name', 'Tên')}${isAll() ? th('namespace', 'Namespace') : ''}${th('status', 'Trạng thái')}${cols.map(([c, l]) => th(c, l, NUM_COLS.has(c) ? 'num' : '')).join('')}${th('age', 'Tuổi' + (ageTitle ? ` <small>${ageTitle}</small>` : ''), 'num')}</tr></thead>
    <tbody>${page.map(n => `<tr data-id="${esc(n.id)}" class="h-${H(n.health)} ${state.selected === n.id ? 'sel' : ''}">
      <td class="hc"><i class="hd" style="--c:var(--${H(n.health)})" title="${esc(n.health)}"></i></td>
      <td class="nm" title="${esc(n.name)}"><span class="t">${esc(n.name)}</span>${!isAll() && n.namespace && n.namespace !== currentNs() ? `<span class="ns-tag">ns ${esc(n.namespace)}</span>` : ''}${n.missing ? '<span class="bad">không tồn tại</span>' : ''}</td>
      ${isAll() ? `<td class="sub">${esc(n.namespace || '—')}</td>` : ''}
      <td class="stc"><span class="pill-st" style="--c:var(--${H(n.health)})">${esc(n.status || '—')}</span>${n.reason ? `<div class="why" title="${esc(n.reason)}">${esc(n.reason)}</div>` : ''}</td>
      ${cols.map(([c]) => `<td class="${NUM_COLS.has(c) ? 'num' : 'txt'}" title="${esc(cellText(n, c))}">${esc(cellText(n, c)) || '<span class="dash">—</span>'}</td>`).join('')}
      <td class="num" title="${esc(n.created || '')}">${esc(age(n.created) || '—')}</td></tr>`).join('')}</tbody></table>`
    : `<div class="tl-empty">Không có ${esc(kindInfo(n0).label)} nào khớp “${esc(gv.q)}”.</div>`;

  // pagination: ‹ 1 … 4 5 6 … 12 ›
  const btn = (p, label, cur, dis) => `<button data-page="${p}" class="${cur ? 'on' : ''}" ${dis ? 'disabled' : ''} ${cur ? 'aria-current="page"' : ''}>${label}</button>`;
  const nums = [];
  for (let p = 0; p < pages; p++) if (p === 0 || p === pages - 1 || Math.abs(p - gv.page) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  $('gvPages').innerHTML = pages > 1
    ? btn(gv.page - 1, '‹', false, gv.page === 0) + nums.map(p => (p === '…' ? '<span class="gap">…</span>' : btn(p, p + 1, p === gv.page))).join('') + btn(gv.page + 1, '›', false, gv.page >= pages - 1)
      + `<span class="pinfo">${gv.page * gv.size + 1}–${Math.min(rows.length, (gv.page + 1) * gv.size)} / ${rows.length}</span>`
    : '';
  gv.tab = tab;
  const at = page.findIndex(n => n.id === state.selected);
  gv.cursor = at >= 0 ? at : Math.min(gv.cursor, Math.max(0, page.length - 1));
  markCursor();
}

function markCursor() {
  const id = gv.rows[gv.cursor]?.id;
  $('gvWrap').querySelectorAll('tr[data-id]').forEach(tr => tr.classList.toggle('cur', tr.dataset.id === id));
  $('gvWrap').querySelector('tr.cur')?.scrollIntoView({ block: 'nearest' });
}
function gridMove(d) {
  if (!gv.rows.length) return;
  gv.cursor = Math.max(0, Math.min(gv.rows.length - 1, gv.cursor + d));
  markCursor();
}
function gridPage(d) { gv.page = Math.max(0, gv.page + d); gv.cursor = 0; renderGrid(); }
function gridOpen(tab) {
  const n = gv.rows[gv.cursor]; if (!n) return;
  if (tab) { state.tab = tab; store.set('tab', tab); }
  showDetailRaw(n);
  renderGrid();
}
function gridKind(k) { gv.kind = k; gv.page = 0; gv.cursor = 0; store.set('grid2.kind', k); renderGrid(); }

function setGrid(open) {
  gv.open = open;
  if (open) closeOtherViews('grid');
  $('grid').hidden = !open;
  // the grid has its own kind tabs, so the graph's filter bar ("Hiển thị") is hidden while it is open
  $('filterbar').hidden = open;
  $('gridBtn').classList.toggle('on', open);
  $('gridBtn').setAttribute('aria-pressed', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'grid'); else if (u.searchParams.get('view') === 'grid') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  if (open) { gv.followSel = true; renderGrid(); $('gvWrap').focus(); }
}
VIEWS.grid = setGrid;

$('gridBtn').onclick = () => setGrid(!gv.open);
$('grid').addEventListener('click', e => {
  const tab = e.target.closest('[data-gtab]');
  if (tab) { gridKind(tab.dataset.gtab); return; }
  const pg = e.target.closest('[data-page]');
  if (pg && !pg.disabled) { gv.page = +pg.dataset.page; gv.cursor = 0; renderGrid(); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const c = th.dataset.sort;
    gv.dir = gv.sort === c ? -gv.dir : 1; gv.sort = c; gv.page = 0;
    store.set('grid2.sort', c); store.set('grid2.dir', String(gv.dir)); renderGrid(); return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr) { gv.cursor = gv.rows.findIndex(n => n.id === tr.dataset.id); gridOpen(); }
});
$('gvQ').addEventListener('input', e => { gv.q = e.target.value.trim(); gv.page = 0; gv.cursor = 0; renderGrid(); });
$('gvQ').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.target.value = ''; gv.q = ''; renderGrid(); $('gvWrap').focus(); } if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); $('gvWrap').focus(); } });
$('gvSize').addEventListener('change', e => { gv.size = +e.target.value; store.set('grid2.size', String(gv.size)); gv.page = 0; renderGrid(); });
// re-render on every graph push / filter change while open
const _render = render;
render = function (fit) { _render(fit); renderGrid(); };
$('q').addEventListener('input', () => { gv.page = 0; renderGrid(); });
if (new URLSearchParams(location.search).get('view') === 'grid') setGrid(true);
