'use strict';
/*
 * k9s-style keyboard: ":" command bar (":po", ":deploy", ":ns shop", ":helm"…), and single-key actions in the grid
 * (j/k move, Enter open, d describe, y YAML, l logs, s shell, e edit) plus view keys. "?" lists them all.
 * Depends on app.js ($, esc, state, store, showDetailRaw), grid.js (gv, setGrid, gridMove, gridOpen, renderGrid), VIEWS.
 */
const CMD_KINDS = {
  po: 'Pod', pod: 'Pod', pods: 'Pod', deploy: 'Deployment', deployment: 'Deployment', deployments: 'Deployment', dp: 'Deployment',
  rs: 'ReplicaSet', sts: 'StatefulSet', statefulset: 'StatefulSet', ds: 'DaemonSet', daemonset: 'DaemonSet', job: 'Job', jobs: 'Job',
  cj: 'CronJob', cronjob: 'CronJob', svc: 'Service', service: 'Service', services: 'Service', ing: 'Ingress', ingress: 'Ingress',
  cm: 'ConfigMap', configmap: 'ConfigMap', secret: 'Secret', secrets: 'Secret', pvc: 'PersistentVolumeClaim', pv: 'PersistentVolume',
  sc: 'StorageClass', no: 'Node', node: 'Node', nodes: 'Node', hpa: 'HorizontalPodAutoscaler', pdb: 'PodDisruptionBudget',
  netpol: 'NetworkPolicy', sa: 'ServiceAccount', role: 'Role', rb: 'RoleBinding', crole: 'ClusterRole', crb: 'ClusterRoleBinding',
};
const CMD_VIEWS = { grid: 'grid', g: 'grid', tl: 'timeline', events: 'timeline', ev: 'timeline', helm: 'helm', sec: 'security', security: 'security', rbac: 'security' };

$('cmdbar').innerHTML = `<div class="cb-row"><span class="cb-p">:</span><input id="cmdIn" autocomplete="off" spellcheck="false" aria-label="Lệnh"
  placeholder="Gõ lệnh: po, deploy, svc, ns shop, helm…"><kbd class="cb-k">Enter</kbd></div><div class="cb-hint" id="cmdHint"></div>`;
const CMD_COMMON = ['po', 'deploy', 'svc', 'ing', 'cm', 'no', 'ns all', 'helm', 'tl', 'sec', 'graph', 'ctx'];
const cmdChips = list => list.map(c => `<button type="button" class="cb-s" data-cmd="${esc(c)}">${esc(c)}</button>`).join('');

function cmdSuggest(v) {
  const [w] = v.trim().split(/\s+/);
  const all = [...Object.keys(CMD_KINDS), ...Object.keys(CMD_VIEWS), 'ns', 'graph', 'ctx', 'q'];
  return w ? all.filter(k => k.startsWith(w.toLowerCase())).slice(0, 8) : [];
}

function openCmd() {
  $('cmdbar').hidden = false;
  $('cmdIn').value = '';
  $('cmdHint').innerHTML = cmdChips(CMD_COMMON);
  $('cmdIn').focus();
}
function closeCmd() { $('cmdbar').hidden = true; $('cmdIn').blur(); }

function runCmd(raw) {
  const [cmd, ...args] = raw.trim().split(/\s+/);
  const c = (cmd || '').toLowerCase();
  if (!c) return;
  if (c === 'graph') { showGraph(); return; }
  if (c === 'q') { backToDefault(); return; }
  if (c === 'ctx') { $('ctx').click(); return; }
  if (c === 'ns') {
    const ns = !args[0] || args[0] === 'all' ? '*' : args[0];
    if (![...$('ns').options].some(o => o.value === ns)) { toast('Không có namespace ' + ns, 'err'); return; }
    $('ns').value = ns; $('ns').dispatchEvent(new Event('change'));
    return;
  }
  if (CMD_VIEWS[c]) { VIEWS[CMD_VIEWS[c]](true); return; }
  const kind = CMD_KINDS[c] || Object.values(CMD_KINDS).find(k => k.toLowerCase() === c);
  if (kind) {
    setGrid(true);
    gridKind(kind);
    if (args[0]) { $('gvQ').value = args.join(' '); $('gvQ').dispatchEvent(new Event('input')); }
    return;
  }
  toast('Không hiểu lệnh: ' + raw, 'err');
}

$('cmdIn').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); const v = $('cmdIn').value; closeCmd(); runCmd(v); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCmd(); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const s = cmdSuggest($('cmdIn').value);
    if (s.length) $('cmdIn').value = s[0] + ($('cmdIn').value.includes(' ') ? $('cmdIn').value.slice($('cmdIn').value.indexOf(' ')) : ' ');
  }
});
$('cmdIn').addEventListener('input', () => { const v = $('cmdIn').value.trim(); const s = cmdSuggest(v); $('cmdHint').innerHTML = cmdChips(v ? s : CMD_COMMON); });
$('cmdbar').addEventListener('pointerdown', e => { const c = e.target.closest('[data-cmd]'); if (!c) return; e.preventDefault(); closeCmd(); runCmd(c.dataset.cmd); });
$('cmdIn').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('cmdIn')) $('cmdbar').hidden = true; }, 100));

/* the graph: close every view (the grid included) and remember it in the URL so a reload stays on it */
function showGraph() {
  closeOtherViews('');
  const u = new URL(location); u.searchParams.set('view', 'graph'); history.replaceState(null, '', u);
}

function showKeys() {
  const k = (keys, what) => `<div class="kk"><span class="kk-k">${keys.map(x => `<kbd>${esc(x)}</kbd>`).join('')}</span><span class="kk-t">${what}</span></div>`;
  const group = (title, items) => `<section class="kg"><h4>${title}</h4>${items.join('')}</section>`;
  openModal(`<div class="m-head"><h3>Phím tắt</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body keys-grid">
      ${group('Chung', [k([':'], 'Thanh lệnh'), k(['/'], 'Tìm kiếm'), k(['?'], 'Bảng phím tắt'), k(['Esc'], 'Đóng / bỏ chọn')])}
      ${group('Chế độ xem', [k(['1'], 'Đồ thị'), k(['2'], 'Bảng'), k(['3'], 'Events timeline'), k(['4'], 'Helm'), k(['5'], 'Bảo mật')])}
      ${group('Trong bảng', [k(['j', 'k'], 'Xuống / lên (↑ ↓)'), k(['g', 'G'], 'Đầu / cuối trang'), k(['[', ']'], 'Trang trước / sau'), k(['Enter'], 'Mở chi tiết')])}
      ${group('Tài nguyên đang chọn', [k(['d'], 'Describe'), k(['y'], 'YAML'), k(['v'], 'Events'), k(['l'], 'Log'), k(['s'], 'Shell vào pod'), k(['e'], 'Sửa YAML')])}
      <p class="kh">Thanh lệnh: <code>po</code> <code>deploy</code> <code>svc</code> <code>ing</code> <code>cm</code> <code>no</code>… mở bảng theo loại · <code>ns shop</code> / <code>ns all</code> đổi namespace · <code>helm</code> <code>tl</code> <code>sec</code> <code>grid</code> <code>graph</code> <code>ctx</code>. <kbd>Tab</kbd> để gợi ý.</p>
    </div>`, box => box.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(false); }));
}

document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable
    || document.activeElement?.closest?.('.CodeMirror, .xterm');
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$('modal').hidden) return;
  // Enter / Space on a focused button or link belongs to that control (e.g. the Conditions toggle), not to the grid cursor
  if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.closest?.('#detail button, #detail a, #detail summary, .dp-menu')) return;
  const views = { 1: () => showGraph(), 2: () => setGrid(true), 3: () => VIEWS.timeline(true), 4: () => VIEWS.helm(true), 5: () => VIEWS.security(true) };
  if (e.key === ':') { e.preventDefault(); openCmd(); return; }
  if (e.key === '?') { e.preventDefault(); showKeys(); return; }
  if (views[e.key]) { e.preventDefault(); views[e.key](); return; }
  const inGrid = gv.open;
  if (inGrid && (e.key === 'j' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopImmediatePropagation(); gridMove(1); return; }
  if (inGrid && (e.key === 'k' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopImmediatePropagation(); gridMove(-1); return; }
  if (inGrid && e.key === 'g') { e.preventDefault(); gridMove(-1e9); return; }
  if (inGrid && e.key === 'G') { e.preventDefault(); gridMove(1e9); return; }
  if (inGrid && e.key === '[') { e.preventDefault(); gridPage(-1); return; }
  if (inGrid && e.key === ']') { e.preventDefault(); gridPage(1); return; }
  if (inGrid && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); gridOpen(); return; }
  // object keys: the grid cursor in the grid, else the selected object
  const target = inGrid ? gv.rows[gv.cursor] : state.graph?.nodes.find(n => n.id === state.selected);
  if (!target) return;
  const tabKeys = { d: 'describe', y: 'yaml', v: 'events' };
  if (tabKeys[e.key]) { e.preventDefault(); state.tab = tabKeys[e.key]; store.set('tab', state.tab); showDetailRaw(target); if (inGrid) renderGrid(); return; }
  if (e.key === 'l' && typeof podsFor === 'function' && podsFor(target.id).length) { e.preventDefault(); openLogsFor(target.id); return; }
  if (e.key === 's' && typeof openTerminalFor === 'function' && state.writeEnabled && podsFor(target.id).length) { e.preventDefault(); openTerminalFor(target.id); return; }
  if (e.key === 'e') { e.preventDefault(); showDetailRaw(target); setTimeout(() => document.querySelector('#detail [data-act=manifest]')?.click(), 50); }
}, true);
