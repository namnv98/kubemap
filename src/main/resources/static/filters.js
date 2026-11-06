'use strict';
/*
 * Kind filter bar: presets (Ứng dụng / Workload / Mạng / Lưu trữ & cấu hình / Quyền / Tất cả), a pill for every kind
 * that is on (click to turn off), and a "Loại" popover with all kinds grouped, counts, search and group toggles.
 * State is app.js's chipOn (persisted per kind); counts come from updateCounts() → state.kindCounts.
 * Depends on app.js ($, esc, store, state, CHIPS, chipOn, KINDS, CUSTOM, ICONS, icon, render).
 */
const FILTER_GROUPS = [
  ['Mạng', ['Ingress', 'Service', 'NetworkPolicy', 'IngressClass']],
  ['Workload', ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'ReplicationController', 'Pod', 'HorizontalPodAutoscaler', 'PodDisruptionBudget']],
  ['Lưu trữ & cấu hình', ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'ConfigMap', 'Secret', 'CSI']],
  ['Quyền & chính sách', ['ServiceAccount', 'RBAC', 'Quota', 'Admission', 'CertificateSigningRequest']],
  ['Cụm', ['Node', 'Scheduling', 'Lease']],
  ['Khác', ['Custom']],
];
const WORKLOAD_CORE = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Pod'];
const FILTER_PRESETS = [
  ['app', 'Ứng dụng', 'Mặc định: luồng ứng dụng (Ingress → Service → workload → Pod → PVC)', () => CHIPS.filter(c => c.on).map(c => c.id)],
  ['workload', 'Workload', 'Workload, ReplicaSet, Pod, HPA, PDB', () => FILTER_GROUPS[1][1]],
  ['net', 'Mạng', 'Ingress, Service, NetworkPolicy và workload phía sau', () => [...FILTER_GROUPS[0][1], ...WORKLOAD_CORE]],
  ['storage', 'Lưu trữ', 'Lưu trữ & cấu hình: PVC, PV, StorageClass, ConfigMap, Secret và workload dùng chúng', () => [...FILTER_GROUPS[2][1], ...WORKLOAD_CORE]],
  ['access', 'Quyền', 'ServiceAccount, RBAC và workload chạy bằng chúng', () => [...FILTER_GROUPS[3][1], ...WORKLOAD_CORE]],
  ['all', 'Tất cả', 'Mọi loại', () => CHIPS.map(c => c.id)],
];
const flt = { open: false, q: '' };

const chipMeta = id => {
  const c = CHIPS.find(x => x.id === id) || { id };
  const k = KINDS[id] || {};
  const label = c.label || k.label || id;
  return { id, label, short: c.short || label, color: c.color || k.color || CUSTOM.color, title: c.title || id, icon: ICONS[id] ? id : 'Custom' };
};

function setKinds(ids) {
  const want = new Set(ids);
  CHIPS.forEach(c => { chipOn[c.id] = want.has(c.id); store.set('chip.' + c.id, chipOn[c.id] ? '1' : '0'); });
  render(false);
  renderFilters();
}
function toggleKind(id, on = !chipOn[id]) {
  chipOn[id] = on; store.set('chip.' + id, on ? '1' : '0');
  render(false);
  renderFilters();
}
function activePreset() {
  const on = CHIPS.filter(c => chipOn[c.id]).map(c => c.id).sort().join();
  return FILTER_PRESETS.find(([, , , ids]) => [...new Set(ids())].sort().join() === on)?.[0] || null;
}

function renderFilters() {
  const bar = $('filterbar');
  if (!bar) return;
  const counts = state.kindCounts || {};
  const preset = activePreset();
  const onKinds = CHIPS.filter(c => chipOn[c.id]).map(c => c.id);
  // kinds that are on but have nothing in this view stay out of the bar (still ticked in the panel)
  const known = !!state.kindCounts; // before the first graph push nothing is "empty" yet
  const emptyOn = known ? onKinds.filter(id => !counts[id]) : [];
  const shown = onKinds.filter(id => !known || counts[id]);
  const compact = shown.length > 6; // many kinds on: kubectl short names (svc, deploy…), full name in the tooltip
  const pills = shown.map(id => {
    const m = chipMeta(id), n = known ? counts[id] || 0 : '…';
    return `<button class="fpill ${n ? '' : 'empty'}" data-off="${id}" style="--c:${m.color}" title="${esc(m.label)}${m.title !== m.id ? ' — ' + esc(m.title) : ''} · bấm để ẩn">
      ${icon(m.icon)}<span>${esc(compact ? m.short : m.label)}</span><span class="n">${n}</span></button>`;
  }).join('') + (emptyOn.length ? `<span class="fempty" title="Đang bật nhưng không có object nào: ${esc(emptyOn.map(id => chipMeta(id).label).join(', '))}">+${emptyOn.length} trống</span>` : '');
  const q = flt.q.toLowerCase();
  const groups = FILTER_GROUPS.map(([name, ids]) => {
    const items = ids.filter(id => CHIPS.some(c => c.id === id)).map(chipMeta).filter(m => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    if (!items.length) return '';
    const on = items.filter(m => chipOn[m.id]).length;
    return `<section class="fg">
      <button class="fg-h" data-group="${esc(name)}" aria-pressed="${on === items.length}">
        <span class="ck ${on === items.length ? 'on' : on ? 'part' : ''}"></span><b>${esc(name)}</b><span class="n">${on}/${items.length}</span></button>
      ${items.map(m => `<button class="fk ${chipOn[m.id] ? 'on' : ''} ${counts[m.id] ? '' : 'empty'}" data-kind="${m.id}" style="--c:${m.color}" title="${esc(m.title)}" role="menuitemcheckbox" aria-checked="${!!chipOn[m.id]}">
        <span class="ck ${chipOn[m.id] ? 'on' : ''}"></span>${icon(m.icon)}<span class="l">${esc(m.label)}</span><span class="n">${counts[m.id] || 0}</span></button>`).join('')}
    </section>`;
  }).join('');
  const html = `
    <span class="label">Hiển thị</span>
    <div class="seg fpresets" role="group" aria-label="Bộ lọc nhanh">${FILTER_PRESETS.map(([id, label, tip]) =>
      `<button data-preset="${id}" class="${preset === id ? 'on' : ''}" title="${esc(tip)}">${label}</button>`).join('')}</div>
    <div class="fpills">${pills || '<span class="fnone">Không loại nào được hiển thị</span>'}</div>
    <label class="fswitch" title="Cho các đường nối nét đứt chạy theo chiều traffic"><input type="checkbox" id="flowSw" ${typeof flow !== 'undefined' && flow.on ? 'checked' : ''}><span class="sw"></span>Chuyển động</label>
    <div class="fmenu ${flt.open ? 'open' : ''}">
      <button class="fbtn" id="fmenuBtn" aria-haspopup="true" aria-expanded="${flt.open}">
        <svg class="i" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Loại <b>${onKinds.length}/${CHIPS.length}</b>
        <svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      <div class="fpanel" role="menu" aria-label="Chọn loại tài nguyên">
        <div class="fp-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="fQ" placeholder="Tìm loại…" value="${esc(flt.q)}" autocomplete="off" aria-label="Tìm loại"></div>
        <div class="fp-groups">${groups || '<p class="muted">Không có loại nào khớp.</p>'}</div>
        <div class="fp-foot"><button class="btn sm" data-preset="app">Mặc định</button><button class="btn sm" data-preset="all">Bật hết</button><button class="btn sm" data-none>Tắt hết</button></div>
      </div>
    </div>`;
  if (bar.dataset.html === html) return;
  const hadFocus = document.activeElement?.id === 'fQ', caret = hadFocus ? document.activeElement.selectionStart : 0;
  const scroll = bar.querySelector('.fp-groups')?.scrollTop || 0;
  bar.innerHTML = html; bar.dataset.html = html;
  const pl = bar.querySelector('.fpills'); // fade the right edge when pills scroll horizontally
  const fade = () => pl.classList.toggle('more', pl.scrollLeft + pl.clientWidth < pl.scrollWidth - 2);
  pl.addEventListener('scroll', fade); fade();
  bar.querySelector('.fp-groups').scrollTop = scroll;
  if (hadFocus) { const i = $('fQ'); i.focus(); i.setSelectionRange(caret, caret); }
}

$('filterbar').addEventListener('change', e => { if (e.target.id === 'flowSw' && typeof setFlow === 'function') setFlow(e.target.checked); });
$('filterbar').addEventListener('click', e => {
  const t = e.target;
  if (t.closest('#fmenuBtn')) { e.stopPropagation(); flt.open = !flt.open; renderFilters(); if (flt.open) $('fQ')?.focus(); return; }
  const pr = t.closest('[data-preset]');
  if (pr) { const p = FILTER_PRESETS.find(x => x[0] === pr.dataset.preset); setKinds(p[3]()); return; }
  if (t.closest('[data-none]')) { setKinds([]); return; }
  const off = t.closest('[data-off]');
  if (off) { toggleKind(off.dataset.off, false); return; }
  const k = t.closest('[data-kind]');
  if (k) { toggleKind(k.dataset.kind); return; }
  const g = t.closest('[data-group]');
  if (g) {
    const ids = FILTER_GROUPS.find(x => x[0] === g.dataset.group)[1].filter(id => CHIPS.some(c => c.id === id));
    const allOn = ids.every(id => chipOn[id]);
    ids.forEach(id => { chipOn[id] = !allOn; store.set('chip.' + id, chipOn[id] ? '1' : '0'); });
    render(false); renderFilters();
  }
});
$('filterbar').addEventListener('input', e => { if (e.target.id === 'fQ') { flt.q = e.target.value; renderFilters(); } });
$('filterbar').addEventListener('keydown', e => { if (e.key === 'Escape' && flt.open) { e.stopPropagation(); flt.open = false; renderFilters(); $('fmenuBtn').focus(); } });
document.addEventListener('click', e => { if (flt.open && !e.target.closest('.fmenu')) { flt.open = false; renderFilters(); } });
renderFilters();

/* the kind filter bar ("Hiển thị") only applies to the graph: hide it whenever a full-canvas view (grid, timeline, helm,
 * security…) is open. Watching the views' hidden attribute covers every way of switching, including view → view. */
const syncFilterbar = () => {
  const graph = !document.querySelector('.app-view:not([hidden])');
  $('filterbar').hidden = !graph;
  // the "Đồ thị" tab is on when no other view is
  $('graphBtn').classList.toggle('on', graph); $('graphBtn').setAttribute('aria-selected', String(graph));
  // the left menu marks the open view; only on a real view change (popovers inside views toggle hidden too)
  const open = [...document.querySelectorAll('.app-view:not([hidden])')].map(v => v.id).join();
  if (open !== syncFilterbar.last) { syncFilterbar.last = open; if (typeof renderGrid === 'function') renderGrid(); if (graph && state.graphStale) render(false); }
};
$('graphBtn').onclick = () => { if (document.querySelector('.app-view:not([hidden])')) showGraph(); };
new MutationObserver(syncFilterbar).observe(document.querySelector('main') || document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
syncFilterbar();
