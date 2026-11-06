'use strict';
/*
 * Helm releases (read-only): list of releases in the current namespace (or all), and for the selected one its
 * resources (click to open them), revision history, values (only fetched on request — they can hold passwords),
 * rendered manifest (Secret values masked by the server) and NOTES.
 * Depends on app.js globals: $, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw, H; actions.js: toast.
 */
const hm = { open: false, list: [], sel: null, detail: null, tab: store.get('helm.tab') || 'resources', q: '', values: null, valuesAll: false, timer: null,
  health: new Set(), page: 0, size: +(store.get('helm.size') || 50), rows: [], cursor: 0, sort: (() => { try { return JSON.parse(store.get('helm.sort') || 'null') || ['updated', -1]; } catch { return ['updated', -1]; } })() };

$('helm').innerHTML = `
  <div class="tl-bar">
    <div class="hm-title"><span class="hm-logo">${HELM_ICON()}</span>Helm releases</div>
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="hmQ" type="search" placeholder="Lọc theo tên, chart…" autocomplete="off" aria-label="Lọc release"></div>
    <div class="seg gv-hf" id="hmHealth" role="group" aria-label="Lọc theo trạng thái"></div>
    <span class="tl-sum" id="hmSum"></span>
    <div class="spacer"></div>
    <label class="gv-size">Mỗi trang <select id="hmSize" aria-label="Số dòng mỗi trang">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
    <nav class="gv-pages" id="hmPages" aria-label="Phân trang"></nav>
    <span class="hm-ro" id="hmRo"></span>
    <button class="icon-btn sm" id="hmClose" title="Đóng" aria-label="Đóng Helm"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="hm-body" id="hmBody">
    <div class="hm-list" id="hmList" tabindex="0" aria-label="Release"></div>
    <div class="hm-detail" id="hmDetail" role="complementary" aria-label="Chi tiết release" hidden></div>
  </div>
  <div class="gv-foot"><kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở chi tiết · <kbd>[</kbd>/<kbd>]</kbd> trang · <kbd>Esc</kbd> đóng chi tiết</div>`;

function HELM_ICON() {
  return '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4M4.6 4.6l2.8 2.8M16.6 16.6l2.8 2.8M4.6 19.4l2.8-2.8M16.6 7.4l2.8-2.8"/></svg>';
}

const HM_STATUS = s => (s === 'deployed' ? 'ok' : s === 'failed' ? 'error' : /^pending/.test(s) || s === 'uninstalling' ? 'warn' : 'unknown');
const hmTime = iso => { if (!iso) return NaN; return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1')); };
function hmAgo(iso) {
  const t = hmTime(iso); if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 172800 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd';
}
const hmKey = r => r.namespace + '/' + r.name;
const statusPill = s => `<span class="hm-st" style="--c:var(--${H(HM_STATUS(s))})">${esc(s || '?')}</span>`;

/* the release list is the grid's table (table.gv-t.dense): sortable columns, status segment with counts, newest first */
const HM_HF = [['ok', 'Deployed'], ['warn', 'Đang chờ'], ['error', 'Lỗi']];
const hmColl = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
const HM_COLS = [
  ['name', 'Tên', r => r.name], ['namespace', 'Namespace', r => r.namespace], ['status', 'Trạng thái', r => ({ error: 0, warn: 1, unknown: 2, ok: 3 })[HM_STATUS(r.status)]],
  ['chart', 'Chart', r => r.chart], ['chartVersion', 'Phiên bản chart', r => r.chartVersion, 'opt'], ['appVersion', 'App', r => r.appVersion || '', 'opt'],
  ['revision', 'Revision', r => r.revision, 'num opt'], ['updated', 'Cập nhật', r => hmTime(r.updated) || 0, 'num age'],
];
function renderHelmList() {
  const q = hm.q.toLowerCase();
  const base = hm.list.filter(r => !q || [r.name, r.namespace, r.chart, r.chartVersion, r.appVersion, r.status].some(x => (x || '').toLowerCase().includes(q)));
  const hg = r => { const h = HM_STATUS(r.status); return h === 'unknown' ? 'warn' : h; };
  const hc = { ok: 0, warn: 0, error: 0 }; base.forEach(r => hc[hg(r)]++);
  [...hm.health].forEach(h => { if (!hc[h]) hm.health.delete(h); });
  const list = hm.health.size ? base.filter(r => hm.health.has(hg(r))) : base;
  $('hmHealth').innerHTML = HM_HF.map(([h, l]) => `<button data-hhf="${h}" class="${hm.health.has(h) ? 'on' : ''}" aria-pressed="${hm.health.has(h)}" ${hc[h] ? '' : 'disabled'}>
    <span class="dot" style="background:var(--${h})"></span>${l}<span class="hn">${hc[h]}</span></button>`).join('');
  $('hmSum').innerHTML = list.length === hm.list.length ? `${hm.list.length} release` : `<b>${list.length}</b> / ${hm.list.length} release`;
  if (!list.length) {
    $('hmList').innerHTML = `<div class="tl-empty">${hm.list.length ? 'Không có release nào khớp bộ lọc. <button class="linkbtn" data-hclear>Xoá lọc</button>' : 'Không có Helm release nào' + (isAll() ? '' : ' trong namespace này') + '.'}
      <div class="muted">Đọc từ Secret <code>helm.sh/release.v1</code> (và ConfigMap owner=helm) mà Helm 3 lưu cho mỗi revision.</div></div>`;
    $('hmPages').innerHTML = ''; hm.rows = [];
    return;
  }
  const [sk, sd] = hm.sort, col = HM_COLS.find(c => c[0] === sk) || HM_COLS[7];
  list.sort((a, b) => { const x = col[2](a), y = col[2](b);
    return ((typeof x === 'number' && typeof y === 'number' ? x - y : hmColl.compare(String(x), String(y))) * sd) || hmColl.compare(a.name, b.name); });
  const th = ([k, l, , cls = '']) => { const on = k === col[0];
    return `<th data-hsort="${k}" class="${cls} ${on ? 'on' : ''}" aria-sort="${on ? (sd > 0 ? 'ascending' : 'descending') : 'none'}" title="Bấm để sắp xếp"><span>${l}${on
      ? `<svg class="i so" viewBox="0 0 24 24"><path d="${sd > 0 ? 'M7 14l5-5 5 5' : 'M7 10l5 5 5-5'}"/></svg>` : '<svg class="i so idle" viewBox="0 0 24 24"><path d="M8 10l4-4 4 4M8 14l4 4 4-4"/></svg>'}</span></th>`; };
  // pages, as the grid; the page follows the selected release
  const pages = Math.max(1, Math.ceil(list.length / hm.size));
  if (hm.followSel) { const at = list.findIndex(r => hmKey(r) === hm.sel); if (at >= 0) hm.page = Math.floor(at / hm.size); hm.followSel = false; }
  hm.page = Math.min(hm.page, pages - 1);
  const page = hm.rows = list.slice(hm.page * hm.size, (hm.page + 1) * hm.size);
  const selAt = page.findIndex(r => hmKey(r) === hm.sel);
  hm.cursor = selAt >= 0 ? selAt : Math.min(hm.cursor, page.length - 1);
  const chev = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const pbtn = (p, label, cur, dis, aria) => `<button data-hpage="${p}" class="${cur ? 'on' : ''}" ${dis ? 'disabled' : ''} ${cur ? 'aria-current="page"' : ''} aria-label="${aria || 'Trang ' + label}">${label}</button>`;
  const nums = [];
  for (let p = 0; p < pages; p++) if (p === 0 || p === pages - 1 || Math.abs(p - hm.page) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  $('hmPages').innerHTML = pages > 1
    ? `<span class="pinfo"><b>${hm.page * hm.size + 1}–${Math.min(list.length, (hm.page + 1) * hm.size)}</b> / ${list.length}</span><div class="pgrp">`
      + pbtn(hm.page - 1, chev('M15 6l-6 6 6 6'), false, hm.page === 0, 'Trang trước')
      + nums.map(p => (p === '…' ? '<span class="gap">…</span>' : pbtn(p, p + 1, p === hm.page))).join('')
      + pbtn(hm.page + 1, chev('M9 6l6 6-6 6'), false, hm.page >= pages - 1, 'Trang sau') + '</div>' : '';
  $('hmSize').value = String(hm.size);
  const txt = (v, cls = '') => `<td class="txt ${cls}" title="${esc(v || '')}">${v ? `<span class="cv">${esc(v)}</span>` : '<span class="dash">—</span>'}</td>`;
  $('hmList').innerHTML = `<table class="gv-t dense hm-t"><thead><tr>${HM_COLS.map(th).join('')}</tr></thead><tbody>${page.map((r, i) => { const h = H(HM_STATUS(r.status));
    return `<tr data-key="${esc(hmKey(r))}" class="h-${h} ${hm.sel === hmKey(r) ? 'sel' : ''} ${i === hm.cursor ? 'cur' : ''}" aria-selected="${hm.sel === hmKey(r)}">
      <td class="nm"><div class="nmw"><span class="ki" style="--c:#4c8dff">${HELM_ICON()}</span><div class="nmt"><span class="t" title="${esc(r.name)}">${esc(r.name)}</span></div></div></td>
      <td class="txt nsc" title="${esc(r.namespace)}"><span class="cv">${esc(r.namespace)}</span></td>
      <td class="stc"><span class="st" style="--c:var(--${h})" title="${esc(r.status || '')}"><i></i>${esc(r.status || '?')}</span></td>
      ${txt(r.chart)}<td class="txt opt"><span class="cv mono">${esc(r.chartVersion || '')}</span></td><td class="txt opt"><span class="cv mono">${esc(r.appVersion || '—')}</span></td>
      <td class="num opt">${r.revision}</td><td class="num age" title="${esc(r.updated || '')}"><span class="av">${hmAgo(r.updated) || '—'}</span></td></tr>`; }).join('')}</tbody></table>`;
}

function renderHelmDetail() {
  const d = hm.detail;
  $('hmBody').classList.toggle('has-detail', !!hm.sel);
  $('hmDetail').hidden = !hm.sel;
  if (!hm.sel) { $('hmDetail').innerHTML = ''; return; }
  if (!d) { $('hmDetail').innerHTML = `<div class="tl-empty"><span class="spinner"></span></div>`; return; }
  const s = d.summary;
  const tabs = [['resources', 'Tài nguyên', d.resources.length], ['history', 'Lịch sử', d.history.length], ['values', 'Values'], ['manifest', 'Manifest'], ['notes', 'Notes']];
  const body = {
    resources: () => {
      const byId = new Map((state.graph?.nodes || []).map(n => [n.id, n]));
      if (!d.resources.length) return `<div class="tl-empty">Manifest không có tài nguyên nào.</div>`;
      return `<div class="hm-res">${d.resources.map(r => {
        const n = byId.get(r.id);
        const st = r.exists === false ? `<span class="hm-miss">không tồn tại</span>` : n ? `<span class="hm-h" style="--c:var(--${H(n.health)})">${esc(n.status || '')}</span>`
          : r.exists === null ? `<span class="muted">không theo dõi</span>` : '';
        return `<button class="hm-r" data-res="${esc(r.id)}" ${r.exists === false ? 'disabled' : ''}>
          <span class="k" style="--c:${kindInfo({ kind: r.kind }).color}">${icon(iconKind({ kind: r.kind }))}</span>
          <span class="kd">${esc(r.kind)}</span><span class="nm">${esc(r.name)}</span>${r.namespace && r.namespace !== s.namespace ? `<span class="muted">${esc(r.namespace)}</span>` : ''}
          <span class="st">${st}</span></button>`;
      }).join('')}</div>`;
    },
    history: () => `<div class="hm-vbar"><button class="btn sm" id="hmCompare" ${d.history.length < 2 ? 'disabled' : ''}>So sánh revision…</button></div>
      <table class="tbl hm-hist"><thead><tr><th>Rev</th><th>Trạng thái</th><th>Chart</th><th>App</th><th>Cập nhật</th><th>Mô tả</th><th></th></tr></thead><tbody>
      ${d.history.map(h => `<tr><td>${h.revision}</td><td>${statusPill(h.status)}</td><td>${esc(h.chart)}-${esc(h.chartVersion)}</td><td>${esc(h.appVersion)}</td>
        <td title="${esc(h.updated)}">${hmAgo(h.updated)} trước</td><td class="desc">${esc(h.description)}</td>
        <td>${hm.canWrite && h.revision !== s.revision ? `<button class="btn sm" data-rollback="${h.revision}">Rollback về rev ${h.revision}</button>` : ''}</td></tr>`).join('')}</tbody></table>`,
    values: () => `<div class="hm-vbar">
        <div class="seg"><button data-vall="0" class="${hm.valuesAll ? '' : 'on'}">Values người dùng</button><button data-vall="1" class="${hm.valuesAll ? 'on' : ''}">Toàn bộ (gộp mặc định của chart)</button></div>
        <select id="hmRev" aria-label="Revision">${d.history.map(h => `<option value="${h.revision}">rev ${h.revision}</option>`).join('')}</select>
        ${hm.values != null ? `<button class="btn sm" data-copy="values">Sao chép</button>` : ''}
      </div>
      ${hm.values == null ? `<div class="hm-reveal"><p>Values có thể chứa mật khẩu hoặc token nên không tự tải.${d.hasUserValues ? '' : ' <span class="muted">(release này không có values người dùng truyền vào)</span>'}</p>
        <button class="btn primary" id="hmShowValues">Hiện values</button></div>`
        : `<pre class="hm-pre">${esc(hm.values)}</pre>`}`,
    manifest: () => `<div class="hm-vbar"><span class="muted">Giá trị trong các Secret đã được ẩn.</span><div class="spacer"></div><button class="btn sm" data-copy="manifest">Sao chép</button></div>
      <pre class="hm-pre">${esc(d.manifest || '(trống)')}</pre>`,
    notes: () => d.notes ? `<pre class="hm-pre">${esc(d.notes)}</pre>` : `<div class="tl-empty">Chart không có NOTES.txt.</div>`,
  };
  if (!tabs.some(t => t[0] === hm.tab)) hm.tab = 'resources';
  $('hmDetail').innerHTML = `
    <header class="hm-head">
      <span class="hm-logo big">${HELM_ICON()}</span>
      <div style="min-width:0"><div class="kind">Helm release · ${esc(s.namespace)}</div><h2>${esc(s.name)}</h2></div>
      ${statusPill(s.status)}
      ${hm.canWrite ? `<button class="btn sm danger-outline" id="hmUninstall">Uninstall</button>` : ''}
      <button class="icon-btn sm" id="hmDClose" title="Đóng (Esc)" aria-label="Đóng chi tiết"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="hm-facts">
      <span><i>Chart</i>${esc(s.chart)}-${esc(s.chartVersion)}</span>${s.appVersion ? `<span><i>App</i>${esc(s.appVersion)}</span>` : ''}
      <span><i>Revision</i>${s.revision}</span><span><i>Cập nhật</i>${hmAgo(s.updated)} trước</span>
      ${d.firstDeployed ? `<span><i>Cài lần đầu</i>${hmAgo(d.firstDeployed)} trước</span>` : ''}<span><i>Lưu trong</i>${esc(s.storage)}</span>
    </div>
    ${s.description ? `<p class="hm-desc">${esc(s.description)}</p>` : ''}
    <nav class="tabs hm-tabs" role="tablist">${tabs.map(([id, label, n]) => `<button role="tab" data-htab="${id}" class="${hm.tab === id ? 'on' : ''}" aria-selected="${hm.tab === id}">${label}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`).join('')}</nav>
    <div class="hm-tab">${body[hm.tab]()}</div>`;
  const rev = $('hmRev'); if (rev && hm.valuesRev) rev.value = hm.valuesRev;
}

async function loadHelm() {
  try {
    const r = await fetch('/api/helm/releases?namespace=' + encodeURIComponent(currentNs()));
    if (!r.ok) throw new Error(r.statusText);
    hm.list = (await r.json()).filter(nsKeep);
    if (hm.sel && !hm.list.some(x => hmKey(x) === hm.sel)) { hm.sel = null; hm.detail = null; } // uninstalled / other namespace
    renderHelmList();
    if (typeof renderGrid === 'function') renderGrid(); // release count in the left menu
    if (hm.sel) await loadHelmDetail(false); else renderHelmDetail();
  } catch (e) {
    $('hmList').innerHTML = `<div class="tl-empty">Không tải được danh sách release: ${esc(e.message)}</div>`;
  }
}

async function loadHelmDetail(reset) {
  const [ns, ...rest] = hm.sel.split('/');
  const r = await fetch(`/api/helm/release?namespace=${encodeURIComponent(ns)}&name=${encodeURIComponent(rest.join('/'))}`);
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) { $('hmDetail').innerHTML = `<div class="tl-empty">${esc(d?.error || 'Không tải được release')}</div>`; return; }
  if (reset) { hm.values = null; hm.valuesRev = null; }
  // live refresh: keep the panel as is unless something changed (keeps scroll and text selection)
  if (!reset && JSON.stringify(d) === JSON.stringify(hm.detail)) return;
  hm.detail = d;
  renderHelmDetail();
}

async function loadValues() {
  const [ns, ...rest] = hm.sel.split('/');
  const rev = hm.valuesRev || hm.detail.summary.revision;
  const r = await fetch(`/api/helm/values?namespace=${encodeURIComponent(ns)}&name=${encodeURIComponent(rest.join('/'))}&revision=${rev}&all=${hm.valuesAll}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || 'Không tải được values', 'err'); return; }
  hm.values = d.yaml;
  hm.valuesRev = rev;
  renderHelmDetail();
}

/* rollback / uninstall go through the helm CLI on the server (write-guarded, audited) */
async function helmAvailability() {
  if (hm.cli !== undefined) return;
  try { hm.cli = await (await fetch('/api/actions/helm/available')).json(); } catch { hm.cli = { available: false }; }
  hm.canWrite = state.writeEnabled && hm.cli.available;
  $('hmRo').textContent = !state.writeEnabled ? 'chỉ xem (writes tắt)' : hm.cli.available ? 'helm ' + hm.cli.version : 'chỉ xem: không tìm thấy helm CLI';
  $('hmRo').title = hm.cli.error || '';
  if (hm.canWrite && typeof helmToolbar === 'function') helmToolbar(); // Repo / Cài chart (helm-install.js)
  renderHelmDetail();
}

async function helmRollback(rev) {
  const s = hm.detail.summary;
  const ok = await confirmAction({ title: `Rollback ${s.name} về revision ${rev}`, ns: s.namespace, confirmLabel: `Rollback → rev ${rev}`,
    body: `<div class="diff"><span class="old">rev ${s.revision}</span> → <span class="new">rev ${rev}</span></div>
      <p>Chạy <code>helm rollback ${esc(s.name)} ${rev} -n ${esc(s.namespace)}</code>: Helm tạo revision mới (${s.revision + 1}) với manifest và values của rev ${rev}, chạy cả hook của chart.</p>` });
  if (!ok) return;
  try { const r = await api('POST', 'helm/rollback', { namespace: s.namespace, name: s.name, revision: rev }); toast(r.message); loadHelmDetail(true); }
  catch (e) { toast(e.message, 'err'); }
}

async function helmUninstall() {
  const s = hm.detail.summary;
  const res = await confirmAction({ title: `Uninstall Helm release ${s.name}`, ns: s.namespace, confirmLabel: 'Uninstall', danger: true, requireText: s.name,
    body: `<p>Chạy <code>helm uninstall ${esc(s.name)} -n ${esc(s.namespace)}</code>: xoá <b>${hm.detail.resources.length}</b> tài nguyên của release (trừ những gì chart đánh dấu giữ lại, ví dụ CRD hay PVC có <code>helm.sh/resource-policy: keep</code>).</p>
      <label class="restart"><input type="checkbox" name="keepHistory"> Giữ lịch sử (<code>--keep-history</code>) để còn rollback được</label>` });
  if (!res) return;
  try { const r = await api('POST', 'helm/uninstall', { namespace: s.namespace, name: s.name, keepHistory: !!res.keepHistory }); toast(r.message); hm.sel = null; hm.detail = null; renderHelmDetail(); loadHelm(); }
  catch (e) { toast(e.message, 'err'); }
}

function setHelm(open) {
  hm.open = open;
  if (open) closeOtherViews('helm');
  $('helm').hidden = !open;
  $('helmBtn').classList.toggle('on', open);
  $('helmBtn').setAttribute('aria-selected', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'helm'); else if (u.searchParams.get('view') === 'helm') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearInterval(hm.timer);
  if (open) { helmAvailability(); loadHelm(); hm.timer = setInterval(loadHelm, 10000); }
}

VIEWS.helm = setHelm;
$('helmBtn').onclick = () => { if (!hm.open) setHelm(true); };
$('hmClose').onclick = () => backToDefault();
$('hmQ').addEventListener('input', e => { hm.q = e.target.value.trim(); hm.page = 0; hm.cursor = 0; renderHelmList(); });
$('hmSize').addEventListener('change', e => { hm.size = +e.target.value; store.set('helm.size', String(hm.size)); hm.page = 0; hm.followSel = true; renderHelmList(); });

/* select a release (null closes the detail panel); the detail loads on the right of the table */
async function helmSelect(key) {
  if (hm.sel === key) return;
  hm.sel = key; hm.detail = null;
  renderHelmList(); renderHelmDetail();
  if (key) await loadHelmDetail(true);
}
/* keyboard, as the grid: j/k move (the open panel follows), Enter opens, [ ] page, Esc closes the panel */
document.addEventListener('keydown', e => {
  if (!hm.open || e.ctrlKey || e.metaKey || e.altKey || !$('modal').hidden) return;
  const ae = document.activeElement;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(ae?.tagName) || ae?.isContentEditable || ae?.closest?.('#detail, #hmDetail button, #hmDetail summary')) return;
  const move = d => { if (!hm.rows.length) return; hm.cursor = Math.max(0, Math.min(hm.rows.length - 1, hm.cursor + d));
    if (hm.sel) helmSelect(hmKey(hm.rows[hm.cursor])); else renderHelmList();
    $('hmList').querySelector('tr.cur')?.scrollIntoView({ block: 'nearest' }); };
  const k = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1, g: -1e9, G: 1e9 }[e.key];
  if (k) { e.preventDefault(); e.stopImmediatePropagation(); move(k); return; }
  if (e.key === '[' || e.key === ']') { e.preventDefault(); e.stopImmediatePropagation(); hm.page = Math.max(0, hm.page + (e.key === ']' ? 1 : -1)); hm.cursor = 0; renderHelmList(); return; }
  if (e.key === 'Enter' && hm.rows[hm.cursor]) { e.preventDefault(); e.stopImmediatePropagation(); helmSelect(hmKey(hm.rows[hm.cursor])); return; }
  if (e.key === 'Escape' && hm.sel) { e.preventDefault(); e.stopImmediatePropagation(); helmSelect(null); }
}, true);
$('helm').addEventListener('click', async e => {
  const th = e.target.closest('th[data-hsort]');
  if (th) { const k = th.dataset.hsort; hm.sort = [k, hm.sort[0] === k ? -hm.sort[1] : (k === 'updated' ? -1 : 1)]; store.set('helm.sort', JSON.stringify(hm.sort)); renderHelmList(); return; }
  const hf = e.target.closest('[data-hhf]');
  if (hf) { const h = hf.dataset.hhf; hm.health.has(h) ? hm.health.delete(h) : hm.health.add(h); renderHelmList(); return; }
  if (e.target.closest('[data-hclear]')) { hm.q = ''; $('hmQ').value = ''; hm.health.clear(); renderHelmList(); return; }
  const pg = e.target.closest('[data-hpage]');
  if (pg) { hm.page = +pg.dataset.hpage; hm.cursor = 0; renderHelmList(); return; }
  if (e.target.closest('#hmDClose')) { helmSelect(null); $('hmList').focus(); return; }
  const it = e.target.closest('#hmList tr[data-key]');
  if (it) { hm.cursor = hm.rows.findIndex(r => hmKey(r) === it.dataset.key); helmSelect(it.dataset.key); return; }
  const t = e.target.closest('[data-htab]');
  if (t) { hm.tab = t.dataset.htab; store.set('helm.tab', hm.tab); renderHelmDetail(); return; }
  if (e.target.closest('#hmShowValues')) { loadValues(); return; }
  const rb = e.target.closest('[data-rollback]');
  if (rb) { helmRollback(+rb.dataset.rollback); return; }
  if (e.target.closest('#hmUninstall')) { helmUninstall(); return; }
  if (e.target.closest('#hmCompare')) { compareHelmRevisions(hm.detail.summary.namespace, hm.detail.summary.name, hm.detail.history); return; }
  const va = e.target.closest('[data-vall]');
  if (va) { hm.valuesAll = va.dataset.vall === '1'; if (hm.values != null) loadValues(); else renderHelmDetail(); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    const text = cp.dataset.copy === 'values' ? hm.values : hm.detail.manifest;
    try { await navigator.clipboard.writeText(text); toast('Đã sao chép'); } catch { toast('Không sao chép được', 'err'); }
    return;
  }
  const res = e.target.closest('[data-res]');
  if (res) {
    const r = hm.detail.resources.find(x => x.id === res.dataset.res);
    const n = state.graph?.nodes.find(x => x.id === r.id) || { id: r.id, kind: r.kind, name: r.name, namespace: r.namespace, health: 'unknown', status: '', info: {}, labels: {} };
    showDetailRaw(n);
  }
});
$('helm').addEventListener('change', e => {
  if (e.target.id === 'hmRev') { hm.valuesRev = +e.target.value; if (hm.values != null) loadValues(); }
});
$('ns').addEventListener('change', () => { if (hm.open) { hm.sel = null; hm.detail = null; loadHelm(); } });
if (new URLSearchParams(location.search).get('view') === 'helm') setHelm(true);
