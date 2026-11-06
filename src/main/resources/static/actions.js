'use strict';
/*
 * Cluster-changing actions (scale, restart, delete pod, CronJob run/suspend, ConfigMap edit).
 * Every action goes through a confirmation dialog that names the cluster, namespace and the exact change.
 * Depends on app.js globals: $, esc, state, cy, kindInfo, icon, KINDS.
 */
state.writeEnabled = false;
fetch('/api/config').then(r => r.json()).then(c => { state.writeEnabled = !!c.writeEnabled; refreshPanel(); }).catch(() => {});

const SCALABLE = ['Deployment', 'StatefulSet', 'ReplicaSet'];
const RESTARTABLE = ['Deployment', 'StatefulSet', 'DaemonSet'];

/* ---------------- HTTP ---------------- */
async function api(method, path, body) {
  const r = await fetch('/api/actions/' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-K8s-Studio': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

/* ---------------- toasts ---------------- */
function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
  t.innerHTML = `<span class="t-ic">${kind === 'ok' ? '<svg class="i" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>'
    : '<svg class="i" viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>'}</span><span class="t-msg">${esc(msg)}</span>`;
  $('toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, kind === 'ok' ? 3500 : 7000);
}

/* ---------------- modal ---------------- */
let modalResolve = null, modalGuard = null;
/* header icon per kind of dialog: [match on the title, svg, tone] — first match wins */
const MODAL_ICONS = [
  [/^Xoá|^Gỡ|^Uninstall/i, '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 'danger'],
  [/^Scale/i, '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', 'accent'],
  [/^Restart|^Khởi động lại/i, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>', 'warn'],
  [/^Rollback|^Hoàn tác/i, '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>', 'warn'],
  [/Port-forward/i, '<path d="M4 8h13l-3-3M20 16H7l3 3"/>', 'accent'],
  [/^Lịch sử/i, '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>', 'accent'],
  [/^Phím tắt/i, '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 15h10"/>', 'accent'],
  [/Helm|repo/i, '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4M4.6 4.6l2.8 2.8M16.6 16.6l2.8 2.8M4.6 19.4l2.8-2.8M16.6 7.4l2.8-2.8"/>', 'accent'],
  [/^So sánh|revision/i, '<path d="M8 3v18M16 3v18M3 8h5M16 16h5"/>', 'accent'],
  [/^Cluster/i, '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', 'accent'],
  [/^(Tạm dừng|Tiếp tục|Chạy ngay|Trigger)/i, '<path d="M7 4l12 8-12 8z"/>', 'accent'],
  [/^Sửa|^Áp dụng|^Lưu/i, '<path d="M4 20h4L19 9l-4-4L4 16z"/>', 'accent'],
  [/./, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', 'accent'],
];

function openModal(html, onOpen, opts = {}) {
  modalGuard = opts.guard || null;
  $('modalBox').className = 'modal' + (opts.wide ? ' wide' : '');
  $('modalBox').innerHTML = html;
  // header: icon tile + title, with the cluster / namespace line moved under the title (wide editors keep their own header)
  const head = $('modalBox').querySelector('.m-head'), h3 = head?.querySelector('h3');
  if (head && h3 && !head.querySelector('.m-ic')) {
    // opts.icon / opts.color: e.g. the kind's own icon and colour for the YAML editor
    const [, svg, tone] = opts.icon ? [null, opts.icon, ''] : MODAL_ICONS.find(([re]) => re.test(h3.textContent.trim()));
    const title = document.createElement('div');
    title.className = 'm-title';
    h3.replaceWith(title);
    title.appendChild(h3);
    const ctx = $('modalBox').querySelector(':scope > .m-ctx');
    if (ctx) title.appendChild(ctx);
    head.insertAdjacentHTML('afterbegin', `<span class="m-ic ${opts.tone || tone}" ${opts.color ? `style="--c:${opts.color}"` : ''}><svg class="i" viewBox="0 0 24 24">${svg}</svg></span>`);
  }
  $('modal').hidden = false;
  requestAnimationFrame(() => $('modal').classList.add('show'));
  if (onOpen) onOpen($('modalBox'));
  const f = $('modalBox').querySelector('[data-autofocus]') || $('modalBox').querySelector('button.primary, button');
  if (f) f.focus();
}
/* user-initiated close (Esc, backdrop, ×) — a guard can refuse, e.g. unsaved YAML edits */
function requestClose() { if (!modalGuard || modalGuard()) closeModal(false); }
function closeModal(result) {
  modalGuard = null;
  $('modal').classList.remove('show');
  setTimeout(() => { $('modal').hidden = true; $('modalBox').innerHTML = ''; }, 150);
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(result); }
}
$('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) requestClose(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('modal').hidden) { e.stopImmediatePropagation(); requestClose(); }
}, true);

const isProd = () => /prod/i.test(state.graph?.context || '');
function contextBar(ns) {
  return `<div class="m-ctx ${isProd() ? 'prod' : ''}">
    <svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
    cluster <b>${esc(state.graph?.context || '?')}</b>${ns ? ` · namespace <b>${esc(ns)}</b>` : ''}
    ${isProd() ? '<span class="m-prod">PRODUCTION?</span>' : ''}</div>`;
}

/* resolves true when the user confirms */
function confirmAction({ title, ns, body, confirmLabel = 'Xác nhận', danger = false, requireText = null }) {
  return new Promise(resolve => {
    modalResolve = resolve;
    const gate = requireText ? `<label class="typecheck"><span>Gõ <code>${esc(requireText)}</code> để xác nhận</span><input id="confirmText" autocomplete="off" spellcheck="false" data-autofocus></label>` : '';
    openModal(`
      <div class="m-head"><h3>${esc(title)}</h3><button class="icon-btn sm" data-m="cancel" aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      ${contextBar(ns)}
      <div class="m-body">${body}${gate}</div>
      <div class="m-foot"><button class="btn" data-m="cancel">Huỷ</button>
        <button class="btn primary ${danger ? 'danger' : ''}" data-m="ok" ${requireText ? 'disabled' : 'data-autofocus'}>${esc(confirmLabel)}</button></div>`,
      box => {
        box.addEventListener('click', e => {
          const b = e.target.closest('[data-m]');
          if (b && !b.disabled) closeModal(b.dataset.m === 'ok' ? collectChecks(box) : false);
        });
        if (requireText) box.querySelector('#confirmText').addEventListener('input', e => {
          box.querySelector('[data-m=ok]').disabled = e.target.value.trim() !== requireText;
        });
      });
  });
}
/* confirm result = object of checked checkboxes (truthy) */
function collectChecks(box) {
  const out = { ok: true, checked: [] };
  box.querySelectorAll('input[type=checkbox][data-val]:checked').forEach(c => out.checked.push(JSON.parse(c.dataset.val)));
  box.querySelectorAll('input[type=radio]:checked').forEach(r => { out[r.name] = r.value; });
  box.querySelectorAll('input[type=checkbox][name]').forEach(c => { out[c.name] = c.checked; });
  return out;
}

async function run(label, fn) {
  try {
    const r = await fn();
    toast(r.message || label);
    state.details.at = 0; // refetch the panel details
    if (state.selected) refreshPanel();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- managed by Argo CD / Flux / Helm / a controller ---------------- */
function managerOf(n) {
  const d = state.details.id === n.id ? state.details.data : null;
  return d && d.manager ? d.manager : null;
}
function mgrWarn(m) {
  if (!m) return '';
  const who = m.tool === 'controller' ? `Do ${esc(m.name)} quản lý` : `Do ${esc(m.tool)} quản lý · ${esc(m.name)}`;
  return `<div class="mgr-warn ${m.revertsQuickly ? 'hot' : ''}"><b>⚠ ${who}</b><div>${esc(m.note)}</div></div>`;
}

/* ---------------- panel section ---------------- */
function desiredReplicas(n) {
  const m = /\/(\d+)/.exec(n.info?.replicas || n.status || '');
  return m ? Number(m[1]) : 0;
}
function hasOwner(id) { return state.graph.edges.some(e => e.type === 'owns' && e.target === id); }

/* toolbar buttons in the panel header (YAML for every kind, read-only when writes are off) */
function actionTools(n) {
  const none = { main: '', more: '', danger: '' };
  if (n.missing) return none;
  const I = p => `<svg class="i" viewBox="0 0 24 24">${p}</svg>`;
  const main = [state.writeEnabled
    ? `<button class="tool" data-act="manifest" title="Sửa manifest (dry-run + diff trước khi áp dụng)">${I('<path d="M4 20h4L19 9l-4-4L4 16z"/>')}Sửa</button>`
    : `<button class="tool" data-act="manifest">${I('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>')}YAML</button>`];
  const more = []; // secondary actions live in the "⋯" menu, so the toolbar stays one row
  const item = (attr, svg, label) => `<button class="mi" role="menuitem" ${attr}>${I(svg)}${label}</button>`;
  // a viewer (login on, not admin) can't start port-forwards; with login off, port-forward works even in read-only mode
  const canForward = typeof auth === 'undefined' || !auth.enabled || auth.admin;
  if (canForward && typeof pfTool === 'function' && pfTool(n)) more.push(item('data-pf="open"', '<path d="M4 8h13l-3-3M20 16H7l3 3"/>', 'Port-forward…'));
  if (state.writeEnabled) {
    if (SCALABLE.includes(n.kind) && !(n.kind === 'ReplicaSet' && hasOwner(n.id)))
      main.push(`<button class="tool" data-act="scale-toggle" aria-expanded="${state.scaleOpen === n.id}">${I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>')}Scale</button>`);
    if (RESTARTABLE.includes(n.kind)) main.push(`<button class="tool" data-act="restart">${I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>')}Restart</button>`);
    if (n.kind === 'CronJob') {
      const suspended = n.status === 'Suspended';
      main.push(`<button class="tool" data-act="trigger">${I('<path d="M7 4l12 8-12 8z"/>')}Chạy ngay</button>`);
      more.push(item(`data-act="${suspended ? 'resume' : 'suspend'}"`, suspended ? '<path d="M7 4l12 8-12 8z"/>' : '<path d="M8 5v14M16 5v14"/>', suspended ? 'Tiếp tục lịch' : 'Tạm dừng lịch'));
    }
    if (n.kind === 'Deployment') {
      const paused = n.info?.paused === 'true';
      more.push(item(`data-act="${paused ? 'resume-rollout' : 'pause-rollout'}"`, paused ? '<path d="M7 4l12 8-12 8z"/>' : '<path d="M8 5v14M16 5v14"/>', paused ? 'Tiếp tục rollout' : 'Tạm dừng rollout'));
    }
    if (typeof openTerminalFor === 'function' && (n.kind === 'Pod' ? n.status === 'Running' || n.status?.startsWith('Running') : podsFor(n.id).length))
      if (n.kind === 'Pod') main.push(`<button class="tool" data-act="terminal">${I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>')}Terminal</button>`);
      else more.unshift(item('data-act="terminal"', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>', 'Terminal vào pod…'));
  }
  if (state.writeEnabled) more.push(`<div class="sep"></div><button class="mi danger" role="menuitem" data-act="delete">${I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>')}Xoá ${esc(kindInfo(n).label)}…</button>`);
  return { main: main.join(''), more: more.join(''), danger: '' };
}

/* the scale stepper row, shown under the toolbar while "Scale" is open */
function actionExtras(n) {
  if (!state.writeEnabled || state.scaleOpen !== n.id || !SCALABLE.includes(n.kind)) return '';
  return `<div class="scale-row"><span class="lab">Replicas</span>
    <div class="stepper"><button data-act="dec" aria-label="Giảm">−</button>
    <input id="replicaInput" type="number" min="0" max="1000" value="${state.scaleValue ?? desiredReplicas(n)}" aria-label="Số replicas">
    <button data-act="inc" aria-label="Tăng">+</button></div>
    <button class="tool primary" data-act="scale">Áp dụng</button><button class="tool" data-act="scale-toggle">Huỷ</button></div>`;
}

$('detail').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || !state.selected) return;
  const n = state.graph.nodes.find(x => x.id === state.selected);
  if (!n) return;
  const act = b.dataset.act, k = kindInfo(n).label;
  const input = $('replicaInput');
  if (act === 'scale-toggle') {
    state.scaleOpen = state.scaleOpen === n.id ? null : n.id; state.scaleValue = null;
    showDetailRaw(n, true);
    if (state.scaleOpen) $('replicaInput')?.select();
    return;
  }
  if (act === 'inc' || act === 'dec') { input.value = Math.max(0, Number(input.value || 0) + (act === 'inc' ? 1 : -1)); state.scaleValue = input.value; return; }

  if (act === 'scale') {
    const from = desiredReplicas(n), to = Number(input.value);
    if (!Number.isInteger(to) || to < 0) return toast('Số replicas không hợp lệ', 'err');
    if (to === from) return toast('Số replicas không thay đổi', 'err');
    const hpa = state.graph.edges.find(x => x.type === 'scales' && x.target === n.id);
    const ok = await confirmAction({ title: `Scale ${k} ${n.name}`, ns: n.namespace, confirmLabel: `Scale → ${to}`, danger: to === 0,
      body: `${mgrWarn(managerOf(n))}<div class="diff"><span class="old">${from}</span> → <span class="new">${to}</span> replicas</div>
        ${to === 0 ? '<p class="warn">Scale về 0 sẽ dừng toàn bộ pod của workload này.</p>' : ''}
        ${hpa ? '<p class="warn">Workload này có HPA — HPA có thể đổi lại số replicas ngay sau đó.</p>' : ''}` });
    if (ok) { state.scaleOpen = null; state.scaleValue = null; run('scale', () => api('POST', 'scale', { kind: n.kind, namespace: n.namespace, name: n.name, replicas: to })); }
  }
  if (act === 'restart') {
    const ok = await confirmAction({ title: `Restart ${k} ${n.name}`, ns: n.namespace, confirmLabel: 'Restart',
      body: `${mgrWarn(managerOf(n)?.tool === 'controller' ? null : managerOf(n))}<p>Tạo lại lần lượt từng pod (rolling restart, giống <code>kubectl rollout restart</code>). Pod mới phải ready thì pod cũ mới bị dừng, theo chiến lược rollout của workload.</p>` });
    if (ok) run('restart', () => api('POST', 'restart', { kind: n.kind, namespace: n.namespace, name: n.name }));
  }
  if (act === 'delete') {
    const kids = dependents(n);
    const kidsText = Object.entries(kids).map(([k, c]) => `${c} ${esc(k)}`).join(', ');
    const isPod = n.kind === 'Pod', managed = hasOwner(n.id);
    const res = await confirmAction({ title: `Xoá ${k} ${n.name}`, ns: n.namespace, confirmLabel: `Xoá ${k}`, danger: true,
      requireText: isPod ? null : n.name,
      body: `${mgrWarn(managerOf(n))}
        ${isPod ? (managed ? '<p>Pod này do một controller quản lý — nó sẽ <b>tạo pod mới</b> thay thế.</p>'
          : '<p class="warn"><b>Pod này không có controller nào quản lý.</b> Xoá là mất hẳn.</p>') : ''}
        ${kidsText ? `<p>Tài nguyên con (theo ownerReference): <b>${kidsText}</b>.</p>` : ''}
        <div class="opts">
          <label><input type="radio" name="propagation" value="Background" checked><div>Background<small>Xoá ngay; tài nguyên con được dọn sau (mặc định của kubectl).</small></div></label>
          <label><input type="radio" name="propagation" value="Foreground"><div>Foreground<small>Đợi tài nguyên con bị xoá hết rồi mới xoá ${esc(k)}.</small></div></label>
          <label><input type="radio" name="propagation" value="Orphan"><div>Orphan<small>Giữ lại tài nguyên con (gỡ ownerReference), chỉ xoá ${esc(k)}.</small></div></label>
          ${isPod ? `<label><input type="checkbox" name="force"><div>Force (grace period 0)<small>Chỉ dùng cho pod kẹt ở Terminating; container có thể không kịp dừng gọn.</small></div></label>` : ''}
        </div>` });
    if (res) run('delete', () => api('POST', 'delete', { kind: n.kind, namespace: n.namespace || '', name: n.name, propagation: res.propagation || 'Background', force: !!res.force }));
  }
  if (act === 'terminal') {
    if (isProd()) {
      const ok = await confirmAction({ title: 'Mở terminal', ns: n.namespace, confirmLabel: 'Mở terminal', body: '<p>Bạn đang mở shell vào một cluster có vẻ là production.</p>' });
      if (!ok) return;
    }
    openTerminalFor(n.id);
  }
  if (act === 'pause-rollout' || act === 'resume-rollout') {
    const p = act === 'pause-rollout';
    const ok = await confirmAction({ title: `${p ? 'Tạm dừng' : 'Tiếp tục'} rollout ${n.name}`, ns: n.namespace, confirmLabel: p ? 'Tạm dừng' : 'Tiếp tục',
      body: `${mgrWarn(managerOf(n))}${p ? '<p>Thay đổi pod template sau đó sẽ <b>không</b> được triển khai cho tới khi tiếp tục (giống <code>kubectl rollout pause</code>). Scale vẫn hoạt động.</p>'
        : '<p>Các thay đổi đang chờ sẽ được triển khai ngay.</p>'}` });
    if (ok) run(act, () => api('POST', 'pause', { namespace: n.namespace, name: n.name, paused: p }));
  }
  if (act === 'rollback' || act === 'hist-diff') {
    const list = state.history?.id === n.id ? state.history.list : [];
    const rev = list.find(r => String(r.revision) === b.dataset.rev), cur = list.find(r => r.current);
    if (!rev || !cur) return;
    if (act === 'hist-diff') return showRevisionDiff(n, rev, cur);
    const ok = await confirmAction({ title: `Rollback ${k} ${n.name} về revision ${rev.revision}`, ns: n.namespace, confirmLabel: `Rollback → rev ${rev.revision}`,
      body: `${mgrWarn(managerOf(n))}<p>Đưa pod template về như revision ${rev.revision} (giống <code>kubectl rollout undo --to-revision=${rev.revision}</code>). Một revision mới sẽ được tạo.</p>
        <div class="mf-diff" style="max-height:340px;border:1px solid var(--border);border-radius:8px">${renderDiff(cur.template, rev.template)}</div>` });
    if (ok) run('rollback', async () => { const r = await api('POST', 'rollback', { kind: n.kind, namespace: n.namespace, name: n.name, revision: rev.revision }); state.history = null; return r; });
  }
  if (act === 'trigger') {
    const ok = await confirmAction({ title: `Chạy ngay CronJob ${n.name}`, ns: n.namespace, confirmLabel: 'Chạy ngay',
      body: `<p>Tạo một Job từ template của CronJob (giống <code>kubectl create job --from=cronjob/${esc(n.name)}</code>), không đợi tới lịch.</p>` });
    if (ok) run('trigger', () => api('POST', 'cronjob/trigger', { kind: 'CronJob', namespace: n.namespace, name: n.name }));
  }
  if (act === 'suspend' || act === 'resume') {
    const s = act === 'suspend';
    const ok = await confirmAction({ title: `${s ? 'Tạm dừng' : 'Tiếp tục'} CronJob ${n.name}`, ns: n.namespace, confirmLabel: s ? 'Tạm dừng' : 'Tiếp tục',
      body: s ? '<p>Lịch chạy sẽ không tạo Job mới cho tới khi tiếp tục. Job đang chạy không bị ảnh hưởng.</p>' : '<p>CronJob chạy lại theo lịch <code>' + esc(n.info?.schedule || '') + '</code>.</p>' });
    if (ok) run(act, () => api('POST', 'cronjob/suspend', { namespace: n.namespace, name: n.name, suspend: s }));
  }
  if (act === 'manifest') openManifest(n);
});

/* objects owned (transitively) by n, counted by kind */
function dependents(n) {
  const kids = new Map();
  state.graph.edges.forEach(e => { if (e.type === 'owns') (kids.get(e.source) || kids.set(e.source, []).get(e.source)).push(e.target); });
  const byId = new Map(state.graph.nodes.map(x => [x.id, x])), out = {}, q = [...(kids.get(n.id) || [])], seen = new Set();
  while (q.length) {
    const id = q.shift(); if (seen.has(id)) continue; seen.add(id);
    const x = byId.get(id); if (x) out[x.kind] = (out[x.kind] || 0) + 1;
    (kids.get(id) || []).forEach(c => q.push(c));
  }
  return out;
}

function showRevisionDiff(n, rev, cur) {
  openModal(`<div class="m-head"><h3>${esc(n.name)}: revision ${cur.revision} (hiện tại) → ${rev.revision}</h3>
      <button class="icon-btn sm" data-x aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="mf-main" style="margin-bottom:18px"><div class="mf-diff">${renderDiff(cur.template, rev.template)}</div></div>`,
    box => box.addEventListener('click', e => { if (e.target.closest('[data-x]')) closeModal(false); }), { wide: true });
}

/* ---------------- ConfigMap editor ---------------- */
/* workloads whose pods use this ConfigMap (pod -mounts-> cm, owner chain up to Deployment/StatefulSet/DaemonSet) */
function workloadsUsing(cmId) {
  const owners = new Map();
  state.graph.edges.forEach(e => { if (e.type === 'owns') (owners.get(e.target) || owners.set(e.target, []).get(e.target)).push(e.source); });
  const byId = new Map(state.graph.nodes.map(n => [n.id, n]));
  const out = new Map();
  state.graph.edges.filter(e => e.type === 'mounts' && e.target === cmId).forEach(e => {
    const q = [e.source], seen = new Set();
    while (q.length) {
      const id = q.shift(); if (seen.has(id)) continue; seen.add(id);
      const n = byId.get(id);
      if (n && RESTARTABLE.includes(n.kind)) { out.set(n.id, { kind: n.kind, name: n.name }); continue; }
      (owners.get(id) || []).forEach(o => q.push(o));
    }
  });
  return [...out.values()];
}

/* ---------------- live manifest (ArgoCD style): view → edit → validate (dry-run) → diff → save ---------------- */
const mf = { n: null, m: null, editor: null, mode: 'view', force: false, saveMode: localStorage.getItem('k8s-studio.saveMode') || 'apply' };
const mfDirty = () => mf.editor && mf.editor.getValue() !== mf.m.yaml;

async function openManifest(n) {
  let m;
  try { m = await api('GET', `manifest?kind=${encodeURIComponent(n.kind)}&namespace=${encodeURIComponent(n.namespace || '')}&name=${encodeURIComponent(n.name)}`); }
  catch (e) { return toast(e.message, 'err'); }
  Object.assign(mf, { n, m, mode: 'view', force: false });
  openModal(`
    <div class="m-head"><h3><span class="mk">${esc(n.kind)}</span>${esc(n.name)}</h3><span class="m-mode" id="mfMode"></span>
      <button class="icon-btn sm" data-mf="close" aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    ${contextBar(n.namespace)}
    <div class="mf-note" id="mfNote"></div>
    ${m.manager ? `<div style="margin:10px 18px 0">${mgrWarn(m.manager).replace('margin: 0 0 12px', '')}</div>` : ''}
    <div class="mf-err" id="mfErr" hidden></div>
    <div class="conflict" id="mfConflict" hidden></div>
    <div class="mf-main"><div class="mf-editor" id="mfEditor"></div><div class="mf-diff" id="mfDiff" hidden></div></div>
    <div class="m-foot" id="mfFoot"></div>`,
    box => {
      mf.editor = CodeMirror($('mfEditor'), {
        value: m.yaml, mode: 'yaml', readOnly: true, lineNumbers: true, tabSize: 2, indentUnit: 2, smartIndent: true,
        extraKeys: { Tab: cm => cm.replaceSelection('  '), 'Ctrl-S': () => mfReview(), 'Cmd-S': () => mfReview() },
      });
      setTimeout(() => mf.editor.refresh(), 160); // after the open animation
      box.addEventListener('click', mfClick);
      mfMode('view');
    },
    { wide: true, icon: ICONS[iconKind(n)], color: kindInfo(n).color, guard: () => {
      if (mf.mode !== 'view' && mfDirty()) { toast('Có thay đổi chưa lưu — bấm "Huỷ thay đổi" để bỏ', 'err'); return false; }
      return true;
    } });
}

function mfMode(mode) {
  mf.mode = mode;
  const w = state.writeEnabled;
  $('mfErr').hidden = true;
  $('mfConflict').hidden = true;
  $('mfEditor').hidden = mode === 'diff';
  $('mfDiff').hidden = mode !== 'diff';
  mf.editor.setOption('readOnly', mode !== 'edit');
  $('modalBox').classList.toggle('editing', mode === 'edit');
  $('mfMode').textContent = { view: 'Live manifest', edit: 'Đang sửa', diff: 'Xem lại thay đổi' }[mode];
  $('mfMode').className = 'm-mode ' + mode;
  const secret = mf.m.secret ? `Giá trị của Secret được che bằng <code>++++++++</code> — để nguyên thì giữ giá trị cũ. Muốn đặt giá trị mới, ghi vào <code>stringData:</code> (chữ thường, không cần base64).` : '';
  $('mfNote').innerHTML = mode === 'edit' ? `Sửa trực tiếp YAML. <code>status</code> do Kubernetes quản lý nên thay đổi ở đó bị bỏ qua. ${secret}`
    : mode === 'view' ? secret : '';
  $('mfNote').hidden = !$('mfNote').innerHTML;
  $('mfFoot').innerHTML = {
    view: `<span class="muted mf-rv">resourceVersion ${esc(mf.m.resourceVersion)}</span>
      <button class="btn" data-mf="copy">Sao chép</button>
      ${w ? '<button class="btn primary" data-mf="edit">Sửa</button>' : ''}`,
    edit: `<span class="muted mf-rv">Ctrl+S để kiểm tra</span>
      <select class="save-mode" id="mfSaveMode" title="Cách lưu">
        <option value="apply" ${mf.saveMode === 'apply' ? 'selected' : ''}>Server-side apply (khuyên dùng)</option>
        <option value="replace" ${mf.saveMode === 'replace' ? 'selected' : ''}>Thay thế toàn bộ object (PUT)</option></select>
      <button class="btn" data-mf="cancel">Huỷ thay đổi</button><button class="btn primary" data-mf="review">Xem thay đổi →</button>`,
    diff: `<span class="muted mf-rv">${mf.saveMode === 'apply' ? 'Server-side apply' + (mf.force ? ' · <b style="color:var(--warn)">ép ghi đè field của manager khác</b>' : '') : 'Thay thế toàn bộ (PUT)'}</span>
      <button class="btn" data-mf="back">← Sửa tiếp</button><button class="btn primary" data-mf="save">Lưu vào cluster</button>`,
  }[mode];
  if (mode === 'edit') { mf.editor.refresh(); mf.editor.focus(); }
}

async function mfClick(e) {
  const b = e.target.closest('[data-mf]');
  if (!b) return;
  const a = b.dataset.mf;
  if (a === 'close') requestClose();
  if (a === 'copy') { navigator.clipboard?.writeText(mf.editor.getValue()).then(() => toast('Đã sao chép YAML'), () => toast('Không sao chép được', 'err')); }
  if (a === 'edit') mfMode('edit');
  if (a === 'cancel') { mf.editor.setValue(mf.m.yaml); mf.force = false; mfMode('view'); }
  if (a === 'review') mfReview();
  if (a === 'force') { mf.force = true; mfReview(); }
  if (a === 'back') mfMode('edit');
  if (a === 'save') mfSave();
}

function mfBody(dryRun) {
  const restart = [...$('mfDiff').querySelectorAll('input[data-val]:checked')].map(c => JSON.parse(c.dataset.val));
  return { kind: mf.n.kind, namespace: mf.n.namespace || '', name: mf.n.name, resourceVersion: mf.m.resourceVersion,
    yaml: mf.editor.getValue(), restart: dryRun ? [] : restart, mode: mf.saveMode, force: mf.force };
}

/* server-side dry-run first: syntax / schema / admission errors show up before anything is changed */
async function mfReview() {
  if (mf.mode !== 'edit') return;
  if (!mfDirty()) return toast('Chưa có thay đổi nào', 'err');
  if ($('mfSaveMode')) { mf.saveMode = $('mfSaveMode').value; localStorage.setItem('k8s-studio.saveMode', mf.saveMode); }
  try { await api('PUT', 'manifest?dryRun=true', mfBody(true)); }
  catch (e) { return mfShowError(e.message); }
  const users = mf.n.kind === 'ConfigMap' ? workloadsUsing(mf.n.id) : [];
  $('mfDiff').innerHTML = renderDiff(mf.m.yaml, mf.editor.getValue())
    + (users.length ? `<div class="restart"><p>Pod đang chạy <b>không tự nhận</b> giá trị mới qua biến môi trường (volume thì cập nhật sau ~1 phút). Restart các workload dùng ConfigMap này sau khi lưu:</p>
      ${users.map(w => `<label><input type="checkbox" data-val='${esc(JSON.stringify(w))}'> ${esc(w.kind)} <b>${esc(w.name)}</b></label>`).join('')}</div>` : '');
  mfMode('diff');
}

/* SSA conflict = you changed a field another manager (HPA, a controller, Argo CD, kubectl…) owns */
function mfShowError(msg) {
  if (msg.startsWith('FIELD_CONFLICT:')) {
    const raw = msg.slice(15).trim();
    const fields = [...raw.matchAll(/conflict with "([^"]+)"[^:]*: (\S+)/g)].map(m => `<li><code>${esc(m[2])}</code> — do <b>${esc(m[1])}</b> quản lý</li>`).join('');
    $('mfConflict').innerHTML = `<b>Xung đột field (server-side apply)</b><ul style="margin:6px 0 0 18px;padding:0">${fields || `<li>${esc(raw)}</li>`}</ul>
      <div>Field này đang do client/controller khác quản lý. Ép ghi sẽ chuyển quyền quản lý field sang <code>k8s-studio</code> — nếu đó là controller (HPA, operator…) nó có thể đổi lại.</div>
      <div class="row"><button class="btn sm danger-outline" data-mf="force">Ép ghi đè (force)</button></div>`;
    $('mfConflict').hidden = false;
    if (mf.mode !== 'edit') mfMode('edit');
    $('mfConflict').hidden = false;
    return;
  }
  if (mf.mode !== 'edit') mfMode('edit');
  $('mfErr').hidden = false; $('mfErr').textContent = msg;
}

async function mfSave() {
  try {
    const r = await api('PUT', 'manifest', mfBody(false));
    toast(r.message);
    state.details.at = 0;
    const fresh = await api('GET', `manifest?kind=${encodeURIComponent(mf.n.kind)}&namespace=${encodeURIComponent(mf.n.namespace || '')}&name=${encodeURIComponent(mf.n.name)}`);
    mf.m = fresh; mf.force = false; mf.editor.setValue(fresh.yaml); mfMode('view');
    if (state.selected) refreshPanel();
  } catch (e) {
    mfShowError(e.message);
  }
}

/* line diff (LCS on the changed middle part), shown as unified hunks with 3 lines of context */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf), n = a2.length, m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = A.slice(0, pre).map((s, k) => ({ t: ' ', s, o: k + 1, nn: k + 1 }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { ops.push({ t: ' ', s: a2[i], o: pre + i + 1, nn: pre + j + 1 }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ t: '+', s: b2[j], nn: pre + j + 1 }); j++; }
    else { ops.push({ t: '-', s: a2[i], o: pre + i + 1 }); i++; }
  }
  A.slice(A.length - suf).forEach((s, k) => ops.push({ t: ' ', s, o: A.length - suf + k + 1, nn: B.length - suf + k + 1 }));
  return ops;
}

function renderDiff(a, b) {
  const ops = lineDiff(a, b), CTX = 3;
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, k) => { if (o.t !== ' ') for (let d = -CTX; d <= CTX; d++) if (ops[k + d]) keep[k + d] = 1; });
  const add = ops.filter(o => o.t === '+').length, del = ops.filter(o => o.t === '-').length;
  let html = `<div class="dstat"><span class="add">+${add}</span> <span class="del">−${del}</span> dòng</div><div class="dlines">`, gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!gap) { html += '<div class="dl gap">⋯</div>'; gap = true; } return; }
    gap = false;
    html += `<div class="dl ${o.t === '+' ? 'a' : o.t === '-' ? 'd' : ''}"><span class="no">${o.o ?? ''}</span><span class="no">${o.nn ?? ''}</span><span class="sg">${o.t}</span><span class="tx">${esc(o.s) || ' '}</span></div>`;
  });
  return html + '</div>';
}

/* ---------------- audit history ---------------- */
$('auditBtn').onclick = async () => {
  let a;
  try { a = await api('GET', 'audit'); } catch (e) { return toast(e.message, 'err'); }
  openModal(`
    <div class="m-head"><h3>Lịch sử thao tác</h3><button class="icon-btn sm" data-x aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body">${a.entries.length ? `<table class="tbl audit">${a.entries.map(x => `<tr>
      <td title="${esc(x.time)}">${esc(age(x.time) || '')}</td><td>${esc(x.context)}</td><td><b>${esc(x.action)}</b></td>
      <td>${esc(x.target)}${x.detail ? `<div class="sub">${esc(x.detail)}</div>` : ''}${x.error ? `<div class="sub bad">${esc(x.error)}</div>` : ''}</td>
      <td class="${x.ok ? 'ok' : 'bad'}">${x.ok ? 'OK' : 'Lỗi'}</td></tr>`).join('')}</table>`
      : '<p class="muted">Chưa có thao tác nào từ khi khởi động.</p>'}
      <p class="muted" style="font-size:11.5px">Toàn bộ lịch sử: <code>${esc(a.file)}</code></p></div>`,
    box => box.addEventListener('click', e => { if (e.target.closest('[data-x]')) closeModal(false); }));
};

/* remember what is typed in the replicas box (the header is re-rendered by live updates) */
$('detail').addEventListener('input', e => { if (e.target.id === 'replicaInput') state.scaleValue = e.target.value; });
