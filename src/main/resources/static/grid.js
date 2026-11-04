'use strict';
/*
 * Grid view: the objects of the current view as tables, one section per kind (in the graph's left-to-right order),
 * each with the columns that matter for that kind. Tabs on top switch to a single kind ("Tất cả" shows every section).
 * Click a column to sort (applies to every section), a section title to fold it; click / Enter opens the detail panel,
 * j / k move the cursor. The graph's filter bar is hidden here: the tabs are the grid's kind filter (search and health chips still apply).
 * Depends on app.js ($, esc, state, store, icon, iconKind, kindInfo, isVisible, isAll, age, H, showDetailRaw,
 * matchesQuery, render), nodes.js (shortNode) and VIEWS.
 */
const gv = { open: false, sort: store.get('grid.sort') || 'name', dir: +(store.get('grid.dir') || 1), cursor: 0, rows: [], kind: null,
  folded: new Set((() => { try { return JSON.parse(store.get('grid.folded') || '[]'); } catch { return []; } })()) };
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
/* reading order of the sections: traffic → workloads → pods → policies → storage → config → access → cluster */
const GRID_ORDER = ['Ingress', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'Pod',
  'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy', 'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass',
  'ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'IngressClass', 'Node'];
const NUM_COLS = new Set(['cpu', 'memory', 'restarts']);

$('grid').innerHTML = `<div class="gv-tabs" id="gvTabs" role="tablist" aria-label="Loại"></div>
  <div class="gv-wrap" tabindex="0" id="gvWrap" aria-label="Bảng tài nguyên"></div>
  <div class="gv-foot" id="gvFoot"></div>`;

const gkey = n => (n.group ? n.group + '/' + n.kind : n.kind); // custom kinds of different API groups stay apart
const numVal = s => { const m = /^([\d.]+)\s*(m|Ki|Mi|Gi|k|M|G)?/.exec(s || ''); if (!m) return null;
  const f = { m: 0.001, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2]] || 1; return +m[1] * f; };
const cellText = (n, k) => { const v = n.info?.[k]; return k === 'node' && v && typeof shortNode === 'function' ? shortNode(v) : v ?? ''; };

function gridRows() {
  const q = state.query.toLowerCase();
  // no filter-bar chips here: every kind is listed (Node only when it runs pods of the view, like on the graph); tabs pick one
  const listed = n => n.kind !== 'Node' || nodeCardWanted(n);
  return (state.graph?.nodes || []).filter(n => listed(n) && matchesQuery(n, q) && (!state.health || n.health === state.health));
}

function sortKey(c) {
  return {
    health: n => HEALTH_ORDER[n.health] ?? 9, name: n => n.name, namespace: n => n.namespace || '', status: n => n.status || '',
    age: n => -(Date.parse(n.created) || 0),
  }[c] || (n => { const t = cellText(n, c); const v = numVal(t); return v ?? t; });
}

function renderGrid() {
  if (!gv.open || !state.graph) return;
  const all = gridRows();
  // sections in the graph's column order (Ingress → Service → workloads → Pod → config / storage → cluster), custom kinds last
  const groups = new Map();
  all.forEach(n => (groups.get(gkey(n)) || groups.set(gkey(n), []).get(gkey(n))).push(n));
  const rank = n => (n.group ? 1000 : GRID_ORDER.indexOf(n.kind) >= 0 ? GRID_ORDER.indexOf(n.kind) : 500);
  const order = [...groups.keys()].sort((a, b) => rank(groups.get(a)[0]) - rank(groups.get(b)[0]) || a.localeCompare(b));
  // ":po" pins a kind by name; a tab click pins a section key — both resolve to a section key here
  const tabKey = gv.kind ? (groups.has(gv.kind) ? gv.kind : order.find(k => groups.get(k)[0].kind === gv.kind) || gv.kind) : null;
  $('gvTabs').innerHTML = `<button role="tab" data-gtab="" class="${!gv.kind ? 'on' : ''}" aria-selected="${!gv.kind}">Tất cả <span class="n">${all.length}</span></button>`
    + order.map(k => {
      const n0 = groups.get(k)[0], bad = groups.get(k).filter(n => n.health === 'error').length;
      return `<button role="tab" data-gtab="${esc(k)}" class="${tabKey === k ? 'on' : ''}" aria-selected="${tabKey === k}" style="--c:${kindInfo(n0).color}"
        title="${esc(kindInfo(n0).label)}${bad ? ` · ${bad} lỗi` : ''}">${icon(iconKind(n0))}${esc(kindInfo(n0).label)} <span class="n">${groups.get(k).length}</span>${bad ? '<i class="bad"></i>' : ''}</button>`;
    }).join('');

  const key = sortKey(gv.sort);
  const cmp = (a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * gv.dir; };
  const shown = gv.kind ? (groups.has(tabKey) ? [tabKey] : []) : order;
  gv.rows = [];
  const th = (c, l, cls = '') => `<th data-sort="${c}" class="${cls} ${gv.sort === c ? 'on' : ''}" aria-sort="${gv.sort === c ? (gv.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${gv.sort === c ? (gv.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const html = shown.map(k => {
    const list = groups.get(k).slice().sort(cmp), n0 = list[0];
    const cols = n0.group ? CUSTOM_COLS : KIND_COLS[n0.kind] || CUSTOM_COLS;
    const folded = !gv.kind && gv.folded.has(k);
    const errs = list.filter(n => n.health === 'error').length, warns = list.filter(n => n.health === 'warn').length;
    if (!folded) gv.rows.push(...list);
    return `<section class="gv-sec ${folded ? 'folded' : ''}">
      <button class="gv-sh" data-fold="${esc(k)}" aria-expanded="${!folded}" style="--c:${kindInfo(n0).color}" ${gv.kind ? 'disabled' : ''}>
        <svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>${icon(iconKind(n0))}<b>${esc(kindInfo(n0).label)}</b><span class="n">${list.length}</span>
        ${errs ? `<span class="gc e">${errs} lỗi</span>` : ''}${warns ? `<span class="gc w">${warns} cảnh báo</span>` : ''}${n0.group ? `<span class="grp">${esc(n0.group)}</span>` : ''}</button>
      ${folded ? '' : `<table class="tbl gv-tbl"><thead><tr>${th('health', '', 'hc')}${th('name', 'Tên')}${isAll() ? th('namespace', 'Namespace') : ''}${th('status', 'Trạng thái')}${cols.map(([c, l]) => th(c, l, NUM_COLS.has(c) ? 'num' : '')).join('')}${th('age', 'Tuổi', 'num')}</tr></thead><tbody>
        ${list.map(n => `<tr data-id="${esc(n.id)}" class="${state.selected === n.id ? 'sel' : ''}">
          <td class="hc"><i class="hd" style="--c:var(--${H(n.health)})" title="${esc(n.health)}"></i></td>
          <td class="nm">${esc(n.name)}${!isAll() && n.namespace && n.namespace !== currentNs() ? ` <span class="ns-tag">ns ${esc(n.namespace)}</span>` : ''}${n.missing ? ' <span class="bad">không tồn tại</span>' : ''}</td>
          ${isAll() ? `<td class="sub">${esc(n.namespace || '—')}</td>` : ''}
          <td><span class="st" style="--c:var(--${H(n.health)})">${esc(n.status || '')}</span>${n.reason ? `<div class="sub">${esc(n.reason)}</div>` : ''}</td>
          ${cols.map(([c]) => `<td class="${NUM_COLS.has(c) ? 'num' : 'sub'}${c === 'images' ? ' img' : ''}" title="${esc(cellText(n, c))}">${esc(cellText(n, c))}</td>`).join('')}
          <td class="num">${esc(age(n.created) || '')}</td></tr>`).join('')}</tbody></table>`}
    </section>`;
  }).join('');
  $('gvWrap').innerHTML = html || `<div class="tl-empty">Không có tài nguyên nào${gv.kind ? ' loại này' : ''} khớp bộ lọc.</div>`;
  const selIdx = gv.rows.findIndex(n => n.id === state.selected);
  gv.cursor = selIdx >= 0 ? selIdx : Math.min(gv.cursor, Math.max(0, gv.rows.length - 1));
  markCursor();
  $('gvFoot').innerHTML = `${all.length} tài nguyên · ${order.length} loại · <kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở · <kbd>d</kbd> describe · <kbd>y</kbd> YAML · <kbd>l</kbd> log · <kbd>:</kbd> lệnh · <kbd>?</kbd> phím tắt`;
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
function gridOpen(tab) {
  const n = gv.rows[gv.cursor]; if (!n) return;
  if (tab) { state.tab = tab; store.set('tab', tab); }
  showDetailRaw(n);
  renderGrid();
}

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
  if (open) { renderGrid(); $('gvWrap').focus(); }
}
VIEWS.grid = setGrid;

$('gridBtn').onclick = () => setGrid(!gv.open);
$('grid').addEventListener('click', e => {
  const tab = e.target.closest('[data-gtab]');
  if (tab) { gv.kind = tab.dataset.gtab || null; gv.cursor = 0; renderGrid(); return; }
  const f = e.target.closest('[data-fold]');
  if (f) {
    const k = f.dataset.fold;
    gv.folded.has(k) ? gv.folded.delete(k) : gv.folded.add(k);
    store.set('grid.folded', JSON.stringify([...gv.folded])); renderGrid(); return;
  }
  const th = e.target.closest('th[data-sort]');
  if (th) { const c = th.dataset.sort; gv.dir = gv.sort === c ? -gv.dir : 1; gv.sort = c; store.set('grid.sort', c); store.set('grid.dir', String(gv.dir)); renderGrid(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr) { gv.cursor = gv.rows.findIndex(n => n.id === tr.dataset.id); gridOpen(); }
});
// re-render on every graph push / filter change while open
const _render = render;
render = function (fit) { _render(fit); renderGrid(); };
$('q').addEventListener('input', () => renderGrid());
if (new URLSearchParams(location.search).get('view') === 'grid') setGrid(true);
