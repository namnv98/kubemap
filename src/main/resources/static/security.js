'use strict';
/*
 * Security view: workload configuration checks, network entry points, and RBAC (who can do what, via which binding),
 * all computed by the server from the informer cache. Click an object to open it in the detail panel.
 * Depends on app.js ($, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw, H) and VIEWS (timeline.js).
 */
const secv = { open: false, tab: store.get('secv.tab') || 'workloads', data: {}, sev: 'all', q: '', showSystem: false, subject: null, timer: null };
const SEV = { high: ['Cao', 'error'], medium: ['Trung bình', 'warn'], low: ['Thấp', 'unknown'] };

$('security').innerHTML = `
  <div class="tl-bar">
    <div class="hm-title"><span class="hm-logo sec">${SEC_ICON()}</span>Bảo mật</div>
    <div class="seg" role="tablist">
      <button data-stab="workloads">Cấu hình workload</button><button data-stab="entry">Lối vào</button><button data-stab="rbac">Quyền RBAC</button>
    </div>
    <div class="seg" id="secSev" role="group" aria-label="Mức độ"><button data-sev="all">Tất cả</button><button data-sev="high">Cao</button><button data-sev="medium">≥ Trung bình</button></div>
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="secQ" type="search" placeholder="Lọc…" autocomplete="off" aria-label="Lọc"></div>
    <span class="tl-sum" id="secSum"></span>
    <div class="spacer"></div>
    <button class="icon-btn sm" id="secClose" title="Đóng (về đồ thị)" aria-label="Đóng bảo mật"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="sec-body" id="secBody"></div>`;

function SEC_ICON() { return '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>'; }
const sevPill = s => `<span class="hm-st" style="--c:var(--${SEV[s][1]})">${SEV[s][0]}</span>`;
const sevOk = s => secv.sev === 'all' || (secv.sev === 'high' ? s === 'high' : s !== 'low');
const kindIcon = kind => `<span class="k" style="--c:${kindInfo({ kind }).color}">${icon(iconKind({ kind }))}</span>`;

function openObject(id, kind, ns, name) {
  const n = state.graph?.nodes.find(x => x.id === id) || { id, kind, name, namespace: ns, health: 'unknown', status: '', info: {}, labels: {} };
  showDetailRaw(n);
}

function renderSecurity() {
  if (!secv.open) return;
  document.querySelectorAll('#security [data-stab]').forEach(b => b.classList.toggle('on', b.dataset.stab === secv.tab));
  document.querySelectorAll('#security [data-sev]').forEach(b => b.classList.toggle('on', b.dataset.sev === secv.sev));
  $('secSev').hidden = secv.tab === 'rbac';
  const q = secv.q.toLowerCase(), d = secv.data[secv.tab];
  if (!d) { $('secBody').innerHTML = `<div class="tl-empty">Đang tải…</div>`; return; }
  ({ workloads: renderWorkloads, entry: renderEntry, rbac: renderRbac })[secv.tab](d, q);
}

function renderWorkloads(list, q) {
  const rows = list.map(w => ({ ...w, findings: w.findings.filter(f => sevOk(f.severity)) }))
    .filter(w => w.findings.length && (!q || [w.name, w.namespace, w.kind, ...w.findings.map(f => f.title)].some(x => (x || '').toLowerCase().includes(q))));
  const count = s => list.reduce((t, w) => t + w.findings.filter(f => f.severity === s).length, 0);
  $('secSum').innerHTML = `<b class="e">${count('high')}</b> cao · <b class="w">${count('medium')}</b> trung bình · ${count('low')} thấp · ${list.length} workload`;
  if (!rows.length) { $('secBody').innerHTML = `<div class="tl-empty">Không có vấn đề nào khớp bộ lọc.</div>`; return; }
  $('secBody').innerHTML = `<div class="sec-list">${rows.map(w => {
    const worst = w.findings.some(f => f.severity === 'high') ? 'high' : w.findings.some(f => f.severity === 'medium') ? 'medium' : 'low';
    return `<section class="sec-card">
      <button class="sec-obj" data-open="${esc(w.id)}" data-kind="${esc(w.kind)}" data-ns="${esc(w.namespace || '')}" data-name="${esc(w.name)}">
        ${kindIcon(w.kind)}<span class="kd">${esc(w.kind)}</span><b>${esc(w.name)}</b>${w.namespace ? `<span class="muted">${esc(w.namespace)}</span>` : ''}
        <span class="muted">SA ${esc(w.serviceAccount)}</span>${sevPill(worst)}</button>
      <ul>${w.findings.map(f => `<li class="s-${f.severity}"><i></i><span><b>${esc(f.title)}</b>${f.detail ? `<span class="muted"> — ${esc(f.detail)}</span>` : ''}</span></li>`).join('')}</ul>
    </section>`;
  }).join('')}</div>`;
}

function renderEntry(list, q) {
  const rows = list.filter(e => sevOk(e.severity) && (!q || [e.name, e.namespace, e.how, e.detail].some(x => (x || '').toLowerCase().includes(q))));
  $('secSum').innerHTML = `<b>${list.length}</b> lối vào · <b class="e">${list.filter(e => e.severity === 'high').length}</b> mở rộng ra ngoài`;
  if (!rows.length) { $('secBody').innerHTML = `<div class="tl-empty">Không có lối vào nào khớp bộ lọc.</div>`; return; }
  $('secBody').innerHTML = `<table class="tbl sec-tbl"><thead><tr><th>Mức</th><th>Kiểu</th><th>Tài nguyên</th><th>Chi tiết</th></tr></thead><tbody>${rows.map(e => `
    <tr class="click" data-open="${esc(e.id)}" data-kind="${esc(e.kind)}" data-ns="${esc(e.namespace || '')}" data-name="${esc(e.name)}">
      <td>${sevPill(e.severity)}</td><td><b>${esc(e.how)}</b></td>
      <td>${kindIcon(e.kind)} ${esc(e.namespace ? e.namespace + '/' : '')}${esc(e.name)}</td><td class="desc">${esc(e.detail)}</td></tr>`).join('')}</tbody></table>`;
}

function renderRbac(list, q) {
  const rows = list.filter(s => (secv.showSystem || !s.system) && (!q || [s.kind, s.name, s.namespace, ...s.flags, ...s.grants.map(g => g.role)].some(x => (x || '').toLowerCase().includes(q))));
  const risky = list.filter(s => !s.system && s.flags.length).length;
  $('secSum').innerHTML = `<b>${list.filter(s => !s.system).length}</b> subject${risky ? ` · <b class="w">${risky}</b> có quyền rủi ro` : ''} · ${list.filter(s => s.system).length} hệ thống`;
  if (!secv.subject || !rows.some(s => skey(s) === secv.subject)) secv.subject = rows[0] ? skey(rows[0]) : null;
  const cur = rows.find(s => skey(s) === secv.subject);
  $('secBody').innerHTML = `
    <div class="sec-can">
      <b>Ai có thể</b>
      <input id="canVerb" value="${esc(secv.canVerb || 'get')}" aria-label="verb" placeholder="verb">
      <input id="canRes" value="${esc(secv.canRes || 'secrets')}" aria-label="resource" placeholder="resource (vd. pods/exec)">
      <input id="canGroup" value="${esc(secv.canGroup || '')}" aria-label="API group" placeholder="API group (trống = core)">
      <span>trong</span><span class="muted">${isAll() ? 'bất kỳ namespace nào' : 'namespace ' + esc(currentNs())}</span>
      <button class="btn sm primary" id="canGo">Tra</button>
      <span class="muted" id="canOut"></span>
    </div>
    <div class="sec-can-res" id="canList"></div>
    <div class="hm-body sec-rbac">
      <div class="hm-list">
        <label class="sec-sys"><input type="checkbox" id="secSys" ${secv.showSystem ? 'checked' : ''}> Hiện subject hệ thống (system:*, kube-*)</label>
        ${rows.map(s => `<button class="hm-item ${skey(s) === secv.subject ? 'sel' : ''}" data-subj="${esc(skey(s))}">
          <i class="dot" style="--c:var(--${s.flags.some(f => /cluster-admin|đọc Secret|leo quyền|exec/.test(f)) ? 'error' : s.flags.length ? 'warn' : 'ok'})"></i>
          <span class="hm-main"><b>${esc(s.name)}</b><span>${esc(s.kind)}${s.namespace ? ' · ' + esc(s.namespace) : ''}</span></span>
          <span class="hm-side"><span>${s.grants.length} rule</span></span></button>`).join('') || '<div class="tl-empty">Không có subject nào.</div>'}
      </div>
      <div class="hm-detail">${cur ? subjectDetail(cur) : ''}</div>
    </div>`;
}

const skey = s => s.kind + '/' + (s.namespace || '') + '/' + s.name;
function subjectDetail(s) {
  const byBinding = new Map();
  s.grants.forEach(g => { const k = g.bindingKind + ' ' + g.binding + ' → ' + g.roleKind + ' ' + g.role + ' @ ' + g.scope; (byBinding.get(k) || byBinding.set(k, { g, rules: [] }).get(k)).rules.push(g); });
  return `<header class="hm-head"><span class="hm-logo big sec">${SEC_ICON()}</span>
      <div style="min-width:0"><div class="kind">${esc(s.kind)}${s.namespace ? ' · ' + esc(s.namespace) : ''}</div><h2>${esc(s.name)}</h2></div></header>
    <div class="sec-flags">${s.flags.length ? s.flags.map(f => `<span class="flag ${/cluster-admin|đọc Secret|leo quyền|exec/.test(f) ? 'bad' : ''}">${esc(f)}</span>`).join('') : '<span class="muted">Không có quyền nào đáng chú ý.</span>'}</div>
    ${[...byBinding.entries()].map(([k, { g, rules }]) => `<section class="sec-grant">
      <div class="sec-gh"><span class="scope">${g.scope === 'cluster' ? 'toàn cluster' : 'ns ' + esc(g.scope)}</span>
        <span>${esc(g.bindingKind)} <b>${esc(g.binding)}</b> → ${esc(g.roleKind)} <b>${esc(g.role)}</b></span></div>
      <table class="tbl"><thead><tr><th>Verbs</th><th>Resources</th><th>Resource names</th></tr></thead><tbody>
      ${rules.map(r => `<tr><td>${esc(r.verbs.join(', '))}</td><td>${r.nonResourceURLs.length ? 'URL ' + esc(r.nonResourceURLs.join(', ')) : esc(r.resources.map(x => r.apiGroups.filter(gp => gp).length ? r.apiGroups.map(gp => gp ? x + '.' + gp : x).join(', ') : x).join(', '))}</td><td>${esc(r.resourceNames.join(', ') || '—')}</td></tr>`).join('')}
      </tbody></table></section>`).join('')}`;
}

async function runCan() {
  secv.canVerb = $('canVerb').value.trim(); secv.canRes = $('canRes').value.trim(); secv.canGroup = $('canGroup').value.trim();
  if (!secv.canVerb || !secv.canRes) return;
  const r = await fetch('/api/security/rbac/can?' + new URLSearchParams({ verb: secv.canVerb, resource: secv.canRes, group: secv.canGroup, namespace: currentNs() }));
  const list = await r.json().catch(() => []);
  const ext = list.filter(a => secv.showSystem || !(a.name.startsWith('system:') || (a.kind === 'ServiceAccount' && (a.namespace || '').startsWith('kube-'))));
  $('canOut').textContent = `${ext.length} subject${list.length !== ext.length ? ` (+${list.length - ext.length} hệ thống)` : ''}`;
  $('canList').innerHTML = ext.length ? ext.map(a => `<span class="flag">${esc(a.kind)} <b>${esc(a.namespace ? a.namespace + '/' : '')}${esc(a.name)}</b> <span class="muted">qua ${esc(a.binding)} · ${esc(a.role)} · ${a.scope === 'cluster' ? 'toàn cluster' : 'ns ' + esc(a.scope)}</span></span>`).join('') : '<span class="muted">Không ai (ngoài subject hệ thống).</span>';
}

async function loadSecurity() {
  const tab = secv.tab, url = { workloads: '/api/security/workloads', entry: '/api/security/entrypoints', rbac: '/api/security/rbac' }[tab];
  try {
    const r = await fetch(url + '?namespace=' + encodeURIComponent(currentNs()));
    if (!r.ok) throw new Error(r.statusText);
    const d = await r.json();
    if (JSON.stringify(d) === JSON.stringify(secv.data[tab])) return; // unchanged: keep scroll position and inputs
    secv.data[tab] = d;
    if (secv.tab === tab) renderSecurity();
  } catch (e) { $('secBody').innerHTML = `<div class="tl-empty">Không tải được: ${esc(e.message)}</div>`; }
}

function setSecurity(open) {
  secv.open = open;
  if (open) closeOtherViews('security');
  $('security').hidden = !open;
  $('secBtn').classList.toggle('on', open);
  $('secBtn').setAttribute('aria-pressed', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'security'); else if (u.searchParams.get('view') === 'security') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearInterval(secv.timer);
  if (open) { renderSecurity(); loadSecurity(); secv.timer = setInterval(loadSecurity, 15000); }
}
VIEWS.security = setSecurity;

$('secBtn').onclick = () => setSecurity(!secv.open);
$('secClose').onclick = () => setSecurity(false);
$('secQ').addEventListener('input', e => { secv.q = e.target.value.trim(); renderSecurity(); });
$('security').addEventListener('click', e => {
  const t = e.target.closest('[data-stab]');
  if (t) { secv.tab = t.dataset.stab; store.set('secv.tab', secv.tab); renderSecurity(); loadSecurity(); return; }
  const sv = e.target.closest('[data-sev]');
  if (sv) { secv.sev = sv.dataset.sev; renderSecurity(); return; }
  const o = e.target.closest('[data-open]');
  if (o) { openObject(o.dataset.open, o.dataset.kind, o.dataset.ns || null, o.dataset.name); return; }
  const s = e.target.closest('[data-subj]');
  if (s) { secv.subject = s.dataset.subj; renderSecurity(); return; }
  if (e.target.closest('#canGo')) runCan();
});
$('security').addEventListener('change', e => { if (e.target.id === 'secSys') { secv.showSystem = e.target.checked; renderSecurity(); } });
$('security').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.sec-can')) runCan(); });
$('ns').addEventListener('change', () => { if (secv.open) { secv.data = {}; renderSecurity(); loadSecurity(); } });
if (new URLSearchParams(location.search).get('view') === 'security') setSecurity(true);
