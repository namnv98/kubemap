'use strict';
/*
 * Helm releases (read-only): list of releases in the current namespace (or all), and for the selected one its
 * resources (click to open them), revision history, values (only fetched on request — they can hold passwords),
 * rendered manifest (Secret values masked by the server) and NOTES.
 * Depends on app.js globals: $, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw, H; actions.js: toast.
 */
const hm = { open: false, list: [], sel: null, detail: null, tab: store.get('helm.tab') || 'resources', q: '', values: null, valuesAll: false, timer: null };

$('helm').innerHTML = `
  <div class="tl-bar">
    <div class="hm-title"><span class="hm-logo">${HELM_ICON()}</span>Helm releases</div>
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="hmQ" type="search" placeholder="Lọc theo tên, chart…" autocomplete="off" aria-label="Lọc release"></div>
    <span class="tl-sum" id="hmSum"></span>
    <div class="spacer"></div>
    <span class="hm-ro" title="Chỉ xem: rollback / uninstall chưa hỗ trợ">chỉ xem</span>
    <button class="icon-btn sm" id="hmClose" title="Đóng (về đồ thị)" aria-label="Đóng Helm"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="hm-body">
    <div class="hm-list" id="hmList" role="listbox" aria-label="Release"></div>
    <div class="hm-detail" id="hmDetail"></div>
  </div>`;

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

function renderHelmList() {
  const q = hm.q.toLowerCase();
  const list = hm.list.filter(r => !q || [r.name, r.namespace, r.chart, r.chartVersion, r.appVersion, r.status].some(x => (x || '').toLowerCase().includes(q)));
  const failed = hm.list.filter(r => HM_STATUS(r.status) !== 'ok').length;
  $('hmSum').innerHTML = `<b>${hm.list.length}</b> release${failed ? ` · <b class="w">${failed}</b> không ở trạng thái deployed` : ''}`;
  if (!list.length) {
    $('hmList').innerHTML = `<div class="tl-empty">${hm.list.length ? 'Không có release nào khớp bộ lọc.' : 'Không có Helm release nào' + (isAll() ? '' : ' trong namespace này') + '.'}
      <div class="muted">Đọc từ Secret <code>helm.sh/release.v1</code> (và ConfigMap owner=helm) mà Helm 3 lưu cho mỗi revision.</div></div>`;
    return;
  }
  $('hmList').innerHTML = list.map(r => `<button class="hm-item ${hm.sel === hmKey(r) ? 'sel' : ''}" data-key="${esc(hmKey(r))}" role="option" aria-selected="${hm.sel === hmKey(r)}">
      <i class="dot" style="--c:var(--${H(HM_STATUS(r.status))})"></i>
      <span class="hm-main"><b>${esc(r.name)}</b><span>${esc(r.chart)}-${esc(r.chartVersion)}${r.appVersion ? ` · app ${esc(r.appVersion)}` : ''}</span></span>
      <span class="hm-side"><span>${esc(r.namespace)}</span><span>rev ${r.revision} · ${hmAgo(r.updated)}</span></span>
    </button>`).join('');
}

function renderHelmDetail() {
  const d = hm.detail;
  if (!d) { $('hmDetail').innerHTML = `<div class="tl-empty">Chọn một release để xem chi tiết.</div>`; return; }
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
      <table class="tbl hm-hist"><thead><tr><th>Rev</th><th>Trạng thái</th><th>Chart</th><th>App</th><th>Cập nhật</th><th>Mô tả</th></tr></thead><tbody>
      ${d.history.map(h => `<tr><td>${h.revision}</td><td>${statusPill(h.status)}</td><td>${esc(h.chart)}-${esc(h.chartVersion)}</td><td>${esc(h.appVersion)}</td>
        <td title="${esc(h.updated)}">${hmAgo(h.updated)} trước</td><td class="desc">${esc(h.description)}</td></tr>`).join('')}</tbody></table>`,
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
    hm.list = await r.json();
    if (!hm.sel && hm.list.length) hm.sel = hmKey(hm.list.find(x => HM_STATUS(x.status) !== 'ok') || hm.list[0]);
    if (hm.sel && !hm.list.some(x => hmKey(x) === hm.sel)) { hm.sel = null; hm.detail = null; }
    renderHelmList();
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

function setHelm(open) {
  hm.open = open;
  if (open) closeOtherViews('helm');
  $('helm').hidden = !open;
  $('helmBtn').classList.toggle('on', open);
  $('helmBtn').setAttribute('aria-pressed', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'helm'); else if (u.searchParams.get('view') === 'helm') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearInterval(hm.timer);
  if (open) { loadHelm(); hm.timer = setInterval(loadHelm, 10000); }
}

VIEWS.helm = setHelm;
$('helmBtn').onclick = () => setHelm(!hm.open);
$('hmClose').onclick = () => setHelm(false);
$('hmQ').addEventListener('input', e => { hm.q = e.target.value.trim(); renderHelmList(); });
$('helm').addEventListener('click', async e => {
  const it = e.target.closest('.hm-item');
  if (it) { hm.sel = it.dataset.key; renderHelmList(); await loadHelmDetail(true); return; }
  const t = e.target.closest('[data-htab]');
  if (t) { hm.tab = t.dataset.htab; store.set('helm.tab', hm.tab); renderHelmDetail(); return; }
  if (e.target.closest('#hmShowValues')) { loadValues(); return; }
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
