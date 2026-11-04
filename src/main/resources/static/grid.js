'use strict';
/*
 * Grid view: every object of the current view as a sortable table (same kind chips and search as the graph).
 * Columns: kind, name, namespace, status, age + the kind's most useful facts (replicas, restarts, node, CPU, memory…).
 * Click / Enter opens the detail panel; j / k (or ↑ ↓) move the cursor when the grid has focus.
 * Depends on app.js ($, esc, state, store, icon, iconKind, kindInfo, isVisible, isAll, age, H, showDetailRaw, matchesQuery) and VIEWS.
 */
const gv = { open: false, sort: store.get('grid.sort') || 'health', dir: +(store.get('grid.dir') || 1), cursor: 0, rows: [] };
const HEALTH_ORDER = { error: 0, warn: 1, unknown: 2, ok: 3 };
const GRID_COLS = [
  ['health', ''], ['kind', 'Loại'], ['name', 'Tên'], ['namespace', 'Namespace'], ['status', 'Trạng thái'],
  ['facts', 'Thông tin'], ['cpu', 'CPU'], ['memory', 'Memory'], ['age', 'Tuổi'],
];
const FACT_KEYS = ['replicas', 'restarts', 'node', 'type', 'clusterIP', 'hosts', 'schedule', 'capacity', 'roles', 'images'];

$('grid').innerHTML = `<div class="gv-wrap" tabindex="0" id="gvWrap" aria-label="Bảng tài nguyên"><table class="tbl gv-tbl"><thead id="gvHead"></thead><tbody id="gvBody"></tbody></table></div>
  <div class="gv-foot" id="gvFoot"></div>`;

const numVal = s => { const m = /^([\d.]+)\s*(m|Ki|Mi|Gi|k|M|G)?/.exec(s || ''); if (!m) return -1;
  const f = { m: 0.001, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2]] || 1; return +m[1] * f; };

function gridRows() {
  const q = state.query.toLowerCase();
  // ":po" etc. pin one kind (shown even if its chip is off); otherwise the graph's kind chips apply
  return (state.graph?.nodes || []).filter(n => (gv.kind ? n.kind === gv.kind : isVisible(n)) && matchesQuery(n, q) && (!state.health || n.health === state.health));
}

function renderGrid() {
  if (!gv.open || !state.graph) return;
  const rows = gridRows();
  const key = {
    health: n => HEALTH_ORDER[n.health] ?? 9, kind: n => kindInfo(n).label, name: n => n.name, namespace: n => n.namespace || '',
    status: n => n.status || '', facts: n => factText(n), cpu: n => numVal(n.info?.cpu), memory: n => numVal(n.info?.memory),
    age: n => -(Date.parse(n.created) || 0),
  }[gv.sort] || (n => n.name);
  rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * gv.dir; });
  gv.rows = rows;
  gv.cursor = Math.min(gv.cursor, Math.max(0, rows.length - 1));
  const selIdx = rows.findIndex(n => n.id === state.selected);
  if (selIdx >= 0) gv.cursor = selIdx;
  $('gvHead').innerHTML = `<tr>${GRID_COLS.filter(([c]) => c !== 'namespace' || isAll()).map(([c, l]) =>
    `<th data-sort="${c}" class="${gv.sort === c ? 'on' : ''}" aria-sort="${gv.sort === c ? (gv.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${gv.sort === c ? (gv.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>`;
  $('gvBody').innerHTML = rows.map((n, i) => `<tr data-id="${esc(n.id)}" class="${i === gv.cursor ? 'cur' : ''} ${state.selected === n.id ? 'sel' : ''}">
      <td><i class="hd" style="--c:var(--${H(n.health)})"></i></td>
      <td class="kd"><span class="k" style="--c:${kindInfo(n).color}">${icon(iconKind(n))}</span>${esc(kindInfo(n).label)}</td>
      <td class="nm">${esc(n.name)}${n.missing ? ' <span class="bad">không tồn tại</span>' : ''}</td>
      ${isAll() ? `<td class="sub">${esc(n.namespace || '—')}</td>` : ''}
      <td><span class="st" style="--c:var(--${H(n.health)})">${esc(n.status || '')}</span>${n.reason ? `<div class="sub">${esc(n.reason)}</div>` : ''}</td>
      <td class="sub">${esc(factText(n))}</td><td class="num">${esc(n.info?.cpu || '')}</td><td class="num">${esc(n.info?.memory || '')}</td>
      <td class="num">${esc(age(n.created) || '')}</td></tr>`).join('');
  $('gvFoot').innerHTML = `${gv.kind ? `<button class="tl-chip" id="gvKindOff">:${esc(gv.kind)} ×</button> ` : ''}${rows.length} tài nguyên · <kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở · <kbd>d</kbd> describe · <kbd>y</kbd> YAML · <kbd>l</kbd> log · <kbd>:</kbd> lệnh · <kbd>?</kbd> phím tắt`;
  $('gvBody').querySelector('tr.cur')?.scrollIntoView({ block: 'nearest' });
}

function factText(n) {
  const i = n.info || {};
  const val = k => (k === 'node' && typeof shortNode === 'function' ? shortNode(i[k]) : i[k]);
  return FACT_KEYS.filter(k => i[k] && !(k === 'images' && n.kind !== 'Pod')).map(k => (k === 'replicas' ? '' : (FACT_LABELS?.[k] || k) + ' ') + val(k)).slice(0, 3).join(' · ');
}

function gridMove(d) {
  if (!gv.rows.length) return;
  gv.cursor = Math.max(0, Math.min(gv.rows.length - 1, gv.cursor + d));
  $('gvBody').querySelectorAll('tr').forEach((tr, i) => tr.classList.toggle('cur', i === gv.cursor));
  $('gvBody').querySelectorAll('tr')[gv.cursor]?.scrollIntoView({ block: 'nearest' });
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
  const th = e.target.closest('th[data-sort]');
  if (th) { const c = th.dataset.sort; gv.dir = gv.sort === c ? -gv.dir : 1; gv.sort = c; store.set('grid.sort', c); store.set('grid.dir', String(gv.dir)); renderGrid(); return; }
  if (e.target.closest('#gvKindOff')) { gv.kind = null; renderGrid(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr) { gv.cursor = gv.rows.findIndex(n => n.id === tr.dataset.id); gridOpen(); }
});
// re-render on every graph push / filter change while open
const _render = render;
render = function (fit) { _render(fit); renderGrid(); };
$('q').addEventListener('input', () => renderGrid());
if (new URLSearchParams(location.search).get('view') === 'grid') setGrid(true);
