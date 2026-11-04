'use strict';
/*
 * Grid view: one table at a time — the kind picked in the left sidebar (kinds grouped, foldable, filterable; a select on
 * narrow screens; remembered; ":po", ":svc"… switch it).
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
  <div class="gv-body">
    <div class="gv-nav" id="gvNav" role="navigation" aria-label="Loại tài nguyên">
      <div class="gv-nav-h"><span class="t">Tài nguyên</span>
        <button class="icon-btn sm gv-mini-btn" id="gvMini" title="Thu gọn thanh bên" aria-label="Thu gọn thanh bên"><svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button></div>
      <div class="gv-nav-q"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="gvNavQ" type="search" placeholder="Lọc loại…" autocomplete="off" aria-label="Lọc loại"></div>
      <div class="gv-nav-list" id="gvTabs" role="tablist" aria-orientation="vertical"></div>
    </div>
    <div class="gv-main">
      <div class="gv-bar">
        <select class="gv-kindsel" id="gvKindSel" aria-label="Loại tài nguyên"></select>
        <div class="gv-title" id="gvTitle"></div>
        <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="gvQ" type="search" placeholder="Tìm trong bảng…" autocomplete="off" aria-label="Tìm trong bảng"></div>
        <span class="gv-count" id="gvCount"></span>
        <div class="seg gv-dens" role="group" aria-label="Mật độ"><button data-dense="0">Thoáng</button><button data-dense="1">Gọn</button></div>
        <div class="spacer"></div>
        <label class="gv-size">Mỗi trang <select id="gvSize" aria-label="Số dòng mỗi trang">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <nav class="gv-pages" id="gvPages" aria-label="Phân trang"></nav>
      </div>
      <div class="gv-wrap" tabindex="0" id="gvWrap" aria-label="Bảng tài nguyên"></div>
      <div class="gv-foot" id="gvFoot"><kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở · <kbd>d</kbd> describe · <kbd>y</kbd> YAML · <kbd>l</kbd> log · <kbd>[</kbd>/<kbd>]</kbd> trang · <kbd>:</kbd> lệnh · <kbd>?</kbd> phím tắt</div>
    </div>
  </div>`;
/* sidebar groups (kinds not listed here fall into "Khác"; custom resources get their own group) */
const GRID_GROUPS = [
  ['Mạng', ['Ingress', 'Service', 'NetworkPolicy', 'IngressClass']],
  ['Workload', ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'Pod', 'HorizontalPodAutoscaler', 'PodDisruptionBudget']],
  ['Lưu trữ', ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass']],
  ['Cấu hình', ['ConfigMap', 'Secret']],
  ['Quyền', ['ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding']],
  ['Cụm', ['Node']],
];
gv.navQ = '';
gv.mini = store.get('grid2.mini') === '1';
gv.dense = store.get('grid2.dense') === '1';
gv.navFolded = new Set((() => { try { return JSON.parse(store.get('grid2.navFolded') || '[]'); } catch { return []; } })());
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
  const label = k => kindInfo(groups.get(k)[0]).label;
  const item = k => {
    const n0 = groups.get(k)[0], bad = groups.get(k).filter(n => n.health === 'error').length;
    return `<button role="tab" data-gtab="${esc(k)}" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}" style="--c:${kindInfo(n0).color}"
      title="${esc(label(k))} · ${groups.get(k).length}${n0.group ? ' · ' + esc(n0.group) : ''}${bad ? ` · ${bad} lỗi` : ''}"><span class="ic">${icon(iconKind(n0))}</span><span class="l">${esc(label(k))}</span>${bad ? '<i class="bad"></i>' : ''}<span class="n">${groups.get(k).length}</span></button>`;
  };
  const nq = gv.navQ.toLowerCase();
  const navGroups = GRID_GROUPS.map(([name, kinds]) => [name, order.filter(k => !groups.get(k)[0].group && kinds.includes(groups.get(k)[0].kind))]);
  const known = new Set(GRID_GROUPS.flatMap(g => g[1]));
  navGroups.push(['Khác', order.filter(k => !groups.get(k)[0].group && !known.has(groups.get(k)[0].kind))]);
  navGroups.push(['Custom resources', order.filter(k => groups.get(k)[0].group)]);
  $('gvTabs').innerHTML = navGroups.map(([name, ks]) => {
    const list = ks.filter(k => !nq || label(k).toLowerCase().includes(nq) || k.toLowerCase().includes(nq));
    if (!list.length) return '';
    if (gv.mini) return `<section class="gv-ng" title="${esc(name)}">${list.map(item).join('')}</section>`; // icon rail: no folding
    const folded = !nq && gv.navFolded.has(name);
    const total = list.reduce((t, k) => t + groups.get(k).length, 0);
    const holdsTab = list.includes(tab), bad = list.some(k => groups.get(k).some(n => n.health === 'error'));
    return `<section class="gv-ng ${folded ? 'folded' : ''}"><button class="gv-nh" data-navfold="${esc(name)}" aria-expanded="${!folded}" title="${folded ? 'Mở' : 'Gập'} nhóm ${esc(name)}">
      <span>${esc(name)}</span>
      ${folded && holdsTab ? `<i class="cur-dot" title="Đang xem ${esc(label(tab))}" style="--c:${kindInfo(groups.get(tab)[0]).color}"></i>` : ''}${folded && bad ? '<i class="bad-dot"></i>' : ''}<span class="n">${total}</span><svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      ${folded ? '' : `<div class="gv-ni">${list.map(item).join('')}</div>`}</section>`;
  }).join('') || '<p class="muted gv-nav-empty">Không có loại nào.</p>';
  $('gvNav').classList.toggle('mini', gv.mini);
  $('grid').querySelector('.gv-body').classList.toggle('mini', gv.mini);
  $('gvMini').title = $('gvMini').ariaLabel = gv.mini ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
  $('gvKindSel').innerHTML = navGroups.filter(g => g[1].length).map(([name, ks]) => `<optgroup label="${esc(name)}">${ks.map(k =>
    `<option value="${esc(k)}" ${tab === k ? 'selected' : ''}>${esc(label(k))} (${groups.get(k).length})</option>`).join('')}</optgroup>`).join('');
  if (tab) {
    const t0 = groups.get(tab)[0];
    $('gvTitle').innerHTML = `<span class="k" style="--c:${kindInfo(t0).color}">${icon(iconKind(t0))}</span><b>${esc(label(tab))}</b>${t0.group ? `<span class="grp">${esc(t0.group)}</span>` : ''}`;
  }
  if (!tab) { $('gvWrap').innerHTML = `<div class="tl-empty">Không có tài nguyên nào khớp bộ lọc.</div>`; $('gvPages').innerHTML = ''; $('gvCount').textContent = ''; gv.rows = []; return; }

  const n0 = groups.get(tab)[0];
  const cols = n0.group ? CUSTOM_COLS : KIND_COLS[n0.kind] || CUSTOM_COLS;
  // search inside the table: name, namespace, status, reason and every column of this kind
  const tq = gv.q.toLowerCase();
  const rows = groups.get(tab).filter(n => !tq || [n.name, n.namespace, n.status, n.reason, ...cols.map(([c]) => cellText(n, c))]
    .some(x => String(x ?? '').toLowerCase().includes(tq)));
  if (!['name', 'status', 'age', ...cols.map(c => c[0])].includes(gv.sort)) { gv.sort = 'age'; gv.dir = 1; }
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
    ? `${rows.length} mục`
    : `<b>${rows.length}</b> / ${groups.get(tab).length} khớp “${esc(gv.q)}”`;

  const sortIcon = c => (gv.sort === c ? `<svg class="i so" viewBox="0 0 24 24"><path d="${gv.dir > 0 ? 'M7 14l5-5 5 5' : 'M7 10l5 5 5-5'}"/></svg>` : '<svg class="i so idle" viewBox="0 0 24 24"><path d="M8 10l4-4 4 4M8 14l4 4 4-4"/></svg>');
  const th = (c, l, cls = '') => `<th data-sort="${c}" class="${cls} ${gv.sort === c ? 'on' : ''}" aria-sort="${gv.sort === c ? (gv.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="Sắp xếp theo ${esc(l || 'tình trạng')}"><span>${l}${sortIcon(c)}</span></th>`;
  const ageTitle = gv.sort === 'age' ? (gv.dir > 0 ? 'mới nhất trước' : 'cũ nhất trước') : '';
  const mono = new Set(['podIP', 'clusterIP', 'images', 'cpu', 'memory', 'internalIP', 'kubelet', 'ports', 'schedule', 'capacity', 'request']);
  const cell = (n, c) => {
    const t = cellText(n, c);
    if (t === '' || t == null) return '<span class="dash">—</span>';
    if (c === 'restarts') { const r = +t || 0; return `<span class="rs ${r > 5 ? 'e' : r > 0 ? 'w' : ''}">${esc(t)}</span>`; }
    if (c === 'node') return `<span class="chipc" title="${esc(n.info?.node || t)}">${esc(t)}</span>`;
    return mono.has(c) ? `<span class="mono">${esc(t)}</span>` : esc(t);
  };
  const created = n => { const d = Date.parse(n.created); return isNaN(d) ? '' : new Date(d).toLocaleString('vi-VN'); };
  const quick = n => `<span class="ra">${typeof podsFor === 'function' && podsFor(n.id).length ? `<button data-row="logs" title="Log (l)"><svg class="i" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg></button>` : ''}
    <button data-row="describe" title="Describe (d)"><svg class="i" viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h6"/></svg></button>
    <button data-row="yaml" title="YAML (y)"><svg class="i" viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg></button></span>`;
  $('gvWrap').innerHTML = page.length ? `<table class="gv-t ${gv.dense ? 'dense' : ''}">
    <thead><tr>${th('name', 'Tên')}${th('status', 'Trạng thái')}${cols.map(([c, l]) => th(c, l, NUM_COLS.has(c) ? 'num' : '')).join('')}${th('age', `<span>Tuổi${ageTitle ? `<small>${ageTitle}</small>` : ''}</span>`, 'num age')}</tr></thead>
    <tbody>${page.map(n => `<tr data-id="${esc(n.id)}" class="h-${H(n.health)} ${state.selected === n.id ? 'sel' : ''}">
      <td class="nm"><div class="nmw"><span class="ki" style="--c:${kindInfo(n).color}">${icon(iconKind(n))}</span>
        <div class="nmt"><span class="t" title="${esc(n.name)}">${esc(n.name)}</span>
          ${(isAll() || (n.namespace && n.namespace !== currentNs())) && n.namespace ? `<span class="ns">${esc(n.namespace)}</span>` : ''}${n.missing ? '<span class="bad">không tồn tại</span>' : ''}</div></div></td>
      <td class="stc"><span class="st" style="--c:var(--${H(n.health)})"><i></i>${esc(n.status || '—')}</span>${n.reason ? `<div class="why" title="${esc(n.reason)}">${esc(n.reason)}</div>` : ''}</td>
      ${cols.map(([c]) => `<td class="${NUM_COLS.has(c) ? 'num' : 'txt'}" title="${esc(cellText(n, c))}">${cell(n, c)}</td>`).join('')}
      <td class="num age" title="Tạo lúc ${esc(created(n))}"><span class="av">${esc(age(n.created) || '—')}</span>${quick(n)}</td></tr>`).join('')}</tbody></table>`
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
  document.querySelectorAll('#grid [data-dense]').forEach(b => b.classList.toggle('on', (b.dataset.dense === '1') === gv.dense));
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
  $('gridBtn').title = open ? 'Đang xem bảng — bấm để xem đồ thị (1)' : 'Xem bảng (2)';
  const u = new URL(location);
  // the grid is the default, so the graph gets the explicit ?view=graph (a reload keeps what the user was looking at)
  if (open) u.searchParams.delete('view'); else if (!u.searchParams.get('view')) u.searchParams.set('view', 'graph');
  history.replaceState(null, '', u);
  if (open) { gv.followSel = true; renderGrid(); $('gvWrap').focus(); }
}
VIEWS.grid = setGrid;

$('gridBtn').onclick = () => (gv.open ? showGraph() : setGrid(true));
$('grid').addEventListener('click', e => {
  const tab = e.target.closest('[data-gtab]');
  if (tab) { gridKind(tab.dataset.gtab); return; }
  const nf = e.target.closest('[data-navfold]');
  if (nf) {
    const g = nf.dataset.navfold;
    gv.navFolded.has(g) ? gv.navFolded.delete(g) : gv.navFolded.add(g);
    store.set('grid2.navFolded', JSON.stringify([...gv.navFolded])); renderGrid(); return;
  }
  const pg = e.target.closest('[data-page]');
  if (pg && !pg.disabled) { gv.page = +pg.dataset.page; gv.cursor = 0; renderGrid(); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const c = th.dataset.sort;
    gv.dir = gv.sort === c ? -gv.dir : 1; gv.sort = c; gv.page = 0;
    store.set('grid2.sort', c); store.set('grid2.dir', String(gv.dir)); renderGrid(); return;
  }
  const dn = e.target.closest('[data-dense]');
  if (dn) { gv.dense = dn.dataset.dense === '1'; store.set('grid2.dense', gv.dense ? '1' : '0'); renderGrid(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  gv.cursor = gv.rows.findIndex(n => n.id === tr.dataset.id);
  const ra = e.target.closest('[data-row]');
  if (ra?.dataset.row === 'logs') { openLogsFor(tr.dataset.id); return; }
  gridOpen(ra ? ra.dataset.row : undefined);
});
$('gvQ').addEventListener('input', e => { gv.q = e.target.value.trim(); gv.page = 0; gv.cursor = 0; renderGrid(); });
$('gvQ').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.target.value = ''; gv.q = ''; renderGrid(); $('gvWrap').focus(); } if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); $('gvWrap').focus(); } });
$('gvMini').addEventListener('click', () => { gv.mini = !gv.mini; store.set('grid2.mini', gv.mini ? '1' : '0'); renderGrid(); });
$('gvNavQ').addEventListener('input', e => { gv.navQ = e.target.value.trim(); renderGrid(); });
$('gvKindSel').addEventListener('change', e => gridKind(e.target.value));
$('gvSize').addEventListener('change', e => { gv.size = +e.target.value; store.set('grid2.size', String(gv.size)); gv.page = 0; renderGrid(); });
// re-render on every graph push / filter change while open
const _render = render;
render = function (fit) { _render(fit); renderGrid(); };
$('q').addEventListener('input', () => { gv.page = 0; renderGrid(); });
/* the grid is the default view: open it unless the URL asks for another one (?view=graph, ?view=helm…) */
{
  const v = new URLSearchParams(location.search).get('view');
  if (!v || v === 'grid') setGrid(true);
}
