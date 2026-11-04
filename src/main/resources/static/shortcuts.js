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

$('cmdbar').innerHTML = `<span class="cb-p">:</span><input id="cmdIn" autocomplete="off" spellcheck="false" aria-label="Lệnh"
  placeholder="po · deploy · svc · ns shop · ns all · helm · tl · sec · grid · graph · ctx  (Tab để gợi ý)"><span class="cb-hint" id="cmdHint"></span>`;

function cmdSuggest(v) {
  const [w] = v.trim().split(/\s+/);
  const all = [...Object.keys(CMD_KINDS), ...Object.keys(CMD_VIEWS), 'ns', 'graph', 'ctx', 'q'];
  return w ? all.filter(k => k.startsWith(w.toLowerCase())).slice(0, 8) : [];
}

function openCmd() {
  $('cmdbar').hidden = false;
  $('cmdIn').value = '';
  $('cmdHint').textContent = '';
  $('cmdIn').focus();
}
function closeCmd() { $('cmdbar').hidden = true; $('cmdIn').blur(); }

function runCmd(raw) {
  const [cmd, ...args] = raw.trim().split(/\s+/);
  const c = (cmd || '').toLowerCase();
  if (!c) return;
  if (c === 'q' || c === 'graph') { closeOtherViews(''); return; }
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
$('cmdIn').addEventListener('input', () => { const s = cmdSuggest($('cmdIn').value); $('cmdHint').textContent = s.length ? s.join('  ') : ''; });
$('cmdIn').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('cmdIn')) $('cmdbar').hidden = true; }, 100));

function showKeys() {
  const k = (keys, what) => `<tr><td>${keys.map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</td><td>${what}</td></tr>`;
  openModal(`<div class="m-head"><h3>Phím tắt</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body"><table class="tbl keys-tbl">
      ${k([':'], 'Thanh lệnh: <code>po</code> <code>deploy</code> <code>svc</code> <code>ing</code> <code>cm</code> <code>no</code>… (mở bảng theo loại), <code>ns shop</code> / <code>ns all</code>, <code>helm</code>, <code>tl</code>, <code>sec</code>, <code>grid</code>, <code>graph</code>, <code>ctx</code>. <kbd>Tab</kbd> gợi ý.')}
      ${k(['/'], 'Tìm kiếm')}
      ${k(['1'], 'Đồ thị')} ${k(['2'], 'Bảng (grid)')} ${k(['3'], 'Events timeline')} ${k(['4'], 'Helm')} ${k(['5'], 'Bảo mật')}
      ${k(['j', 'k'], 'Bảng: xuống / lên (cũng ↑ ↓)')} ${k(['g', 'G'], 'Bảng: đầu / cuối trang')} ${k(['[', ']'], 'Bảng: trang trước / sau')}
      ${k(['Enter'], 'Bảng: mở chi tiết')} ${k(['d'], 'Describe')} ${k(['y'], 'YAML')} ${k(['v'], 'Events của tài nguyên')}
      ${k(['l'], 'Log (pod / workload)')} ${k(['s'], 'Shell vào pod')} ${k(['e'], 'Sửa YAML')}
      ${k(['Esc'], 'Đóng / bỏ chọn')} ${k(['?'], 'Bảng này')}
    </table></div>`, box => box.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(false); }));
}

document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable
    || document.activeElement?.closest?.('.CodeMirror, .xterm');
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$('modal').hidden) return;
  const views = { 1: () => closeOtherViews(''), 2: () => setGrid(true), 3: () => VIEWS.timeline(true), 4: () => VIEWS.helm(true), 5: () => VIEWS.security(true) };
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
