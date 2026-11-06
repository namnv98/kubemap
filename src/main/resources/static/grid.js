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
const gv = { open: false, cursor: 0, rows: [], health: new Set(), ns: new Set(), nsOpen: false, nsQ: '', help: false, colOpen: false,
  colCfg: (() => { try { return JSON.parse(store.get('grid2.cols') || '{}'); } catch { return {}; } })(),
  sorts: (() => { try { return JSON.parse(store.get('grid2.sorts') || '{}'); } catch { return {}; } })(),
  kind: store.get('grid2.kind') || 'Pod', q: '', page: 0, size: +(store.get('grid2.size') || 50) };
const HEALTH_ORDER = { error: 0, warn: 1, unknown: 2, ok: 3 };
const RES = [['cpu', 'CPU'], ['memory', 'Memory']];
const KIND_COLS = {
  Pod: [['ready', 'Ready'], ['containers', 'Containers'], ['restarts', 'Restarts'], ['node', 'Node'], ['podIP', 'IP'], ['qos', 'QoS'], ...RES],
  Deployment: [['replicas', 'Ready'], ['updated', 'Up-to-date'], ['strategy', 'Strategy'], ['image', 'Image'], ['tag', 'Tag'], ...RES],
  StatefulSet: [['replicas', 'Ready'], ['serviceName', 'Service'], ['image', 'Image'], ['tag', 'Tag'], ...RES],
  DaemonSet: [['ready', 'Ready'], ['image', 'Image'], ['tag', 'Tag'], ...RES],
  ReplicaSet: [['image', 'Image'], ['tag', 'Tag'], ...RES],
  Job: [['succeeded', 'Succeeded'], ['failed', 'Failed'], ['completed', 'Hoàn thành']],
  CronJob: [['schedule', 'Lịch'], ['active', 'Đang chạy'], ['lastSchedule', 'Chạy gần nhất'], ['lastSuccess', 'Thành công gần nhất']],
  Service: [['type', 'Type'], ['clusterIP', 'Cluster IP'], ['port', 'Port'], ['targetPort', 'Target port'], ['protocol', 'Protocol'], ['nodePort', 'NodePort'],
    ['endpoints', 'Endpoints'], ['selector', 'Selector']],
  Ingress: [['hosts', 'Hosts'], ['class', 'Class'], ['address', 'Address'], ['tls', 'TLS']],
  IngressClass: [['controller', 'Controller']],
  HorizontalPodAutoscaler: [['current', 'Hiện tại'], ['desired', 'Mong muốn'], ['minReplicas', 'Min'], ['maxReplicas', 'Max'], ['metricNow', 'Metric hiện tại'], ['metricTarget', 'Mục tiêu']],
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
  Node: [['roles', 'Roles'], ['internalIP', 'IP'], ['kubelet', 'Kubelet'], ['cpuUsed', 'CPU'], ['cpuPct', 'CPU %'], ['memUsed', 'Memory'], ['memPct', 'Memory %']],
  ReplicationController: [['replicas', 'Ready'], ['image', 'Image'], ['tag', 'Tag'], ...RES],
  ReplicationController: [['replicas', 'Ready'], ['images', 'Image'], ...RES],
  ResourceQuota: [], LimitRange: [],
  PriorityClass: [['value', 'Value'], ['globalDefault', 'Mặc định'], ['preemptionPolicy', 'Preemption']],
  RuntimeClass: [['handler', 'Handler']],
  MutatingWebhookConfiguration: [['webhooks', 'Webhooks'], ['failurePolicy', 'Failure policy'], ['targets', 'Gọi tới']],
  ValidatingWebhookConfiguration: [['webhooks', 'Webhooks'], ['failurePolicy', 'Failure policy'], ['targets', 'Gọi tới']],
  ValidatingAdmissionPolicy: [['validations', 'Validations'], ['failurePolicy', 'Failure policy'], ['paramKind', 'Param']],
  ValidatingAdmissionPolicyBinding: [['policy', 'Policy'], ['actions', 'Actions']],
  APIService: [['api', 'API'], ['service', 'Service']],
  CertificateSigningRequest: [['signer', 'Signer'], ['username', 'Người yêu cầu'], ['usages', 'Usages']],
  VolumeAttachment: [['pv', 'PV'], ['node', 'Node'], ['attacher', 'Attacher']],
  CSIDriver: [['attachRequired', 'Attach'], ['podInfoOnMount', 'Pod info'], ['modes', 'Modes']],
  CSINode: [['drivers', 'Drivers']],
  Lease: [['holder', 'Holder'], ['duration', 'Duration'], ['transitions', 'Transitions']],
  Gateway: [['listeners', 'Listeners'], ['address', 'Address']], GatewayClass: [['controller', 'Controller']],
  HTTPRoute: [['hosts', 'Hosts']], GRPCRoute: [['hosts', 'Hosts']], TLSRoute: [['hosts', 'Hosts']], TCPRoute: [], UDPRoute: [],
  IngressRoute: [['hosts', 'Hosts'], ['entryPoints', 'Entry points']], IngressRouteTCP: [['hosts', 'Hosts'], ['entryPoints', 'Entry points']],
  IngressRouteUDP: [['entryPoints', 'Entry points']],
};
const CUSTOM_COLS = [['apiVersion', 'API']];
const NUM_COLS = new Set(['cpu', 'memory', 'restarts', 'succeeded', 'failed', 'current', 'desired', 'minReplicas', 'maxReplicas', 'cpuUsed', 'cpuPct', 'memUsed', 'memPct', 'port', 'targetPort', 'nodePort']);

/* columns computed from a combined value: image → image / tag, HPA metric → now / target, node usage → amount / % */
const splitImage = ref => {
  const at = ref.indexOf('@'); if (at > 0) return [ref.slice(0, at), ref.slice(at + 1, at + 20) + '…']; // digest
  const slash = ref.lastIndexOf('/'), colon = ref.lastIndexOf(':');
  return colon > slash ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, 'latest'];
};
const images = n => String(n.info?.images || '').split(/,\s*/).filter(Boolean);
const hpaMetric = n => Object.entries(n.info || {}).find(([k, v]) => !['replicas', 'desired', 'current', 'minReplicas', 'maxReplicas'].includes(k) && / \/ /.test(v));
const DERIVED = {
  image: n => [...new Set(images(n).map(i => splitImage(i)[0]))].join(', '),
  tag: n => [...new Set(images(n).map(i => splitImage(i)[1]))].join(', '),
  metricNow: n => { const m = hpaMetric(n); return m ? `${m[0]} ${m[1].split(' / ')[0]}` : ''; },
  metricTarget: n => { const m = hpaMetric(n); return m ? m[1].split(' / ')[1] : ''; },
  cpuUsed: n => String(n.info?.cpu || '').split(' / ')[0],
  memUsed: n => String(n.info?.memory || '').split(' / ')[0],
  cpuPct: n => (n.info?.cpuPct != null ? n.info.cpuPct + '%' : ''),
  memPct: n => (n.info?.memPct != null ? n.info.memPct + '%' : ''),
};
/* tab order: traffic → workloads → pods → policies → storage → config → access → cluster; custom kinds last */
const GRID_ORDER = ['Gateway', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute', 'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP',
  'Middleware', 'Ingress', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'ReplicaSet', 'ReplicationController', 'Pod',
  'HorizontalPodAutoscaler', 'PodDisruptionBudget', 'NetworkPolicy', 'PersistentVolumeClaim', 'PersistentVolume', 'StorageClass',
  'VolumeAttachment', 'CSIDriver', 'CSINode', 'ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding',
  'ResourceQuota', 'LimitRange', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration', 'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding', 'CertificateSigningRequest', 'IngressClass', 'GatewayClass', 'APIService', 'PriorityClass', 'RuntimeClass',
  'Lease', 'Node'];

/* the app-wide left menu (resource kinds + Tổng quan / Bảo mật sections) lives in #appNav, outside the grid view, and is
 * rendered by renderGrid() whether the grid is open or not; the grid itself is just the main column */
$('appNav').innerHTML = `
    <div class="gv-nav" id="gvNav" role="navigation" aria-label="Điều hướng">
      <div class="gv-nav-h"><span class="t">Danh mục</span>
        <button class="icon-btn sm gv-mini-btn" id="gvMini" title="Thu gọn thanh bên" aria-label="Thu gọn thanh bên"><svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button></div>
      <div class="gv-nav-q"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="gvNavQ" type="search" placeholder="Tìm mục…" autocomplete="off" aria-label="Tìm mục"></div>
      <div class="gv-nav-list" id="gvTabs" role="tablist" aria-orientation="vertical"></div>
    </div>`;
$('grid').innerHTML = `
  <div class="gv-body">
    <div class="gv-main">
      <div class="gv-bar">
        <select class="gv-kindsel" id="gvKindSel" aria-label="Loại tài nguyên"></select>
        <div class="gv-title" id="gvTitle"></div>
        <div class="gv-infow" id="gvInfoWrap" hidden><button class="icon-btn sm gv-ibtn" id="gvInfoBtn" aria-expanded="false" aria-controls="gvInfo"
          title="Loại tài nguyên này là gì?"><svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg></button>
          <div class="gv-pop gv-kinfo" id="gvInfo" role="dialog" aria-label="Giải thích loại tài nguyên" hidden></div></div>
        <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="gvQ" type="search" placeholder="Tìm… hoặc ns:shop  restarts>3  app=cart" autocomplete="off" aria-label="Tìm và lọc trong bảng"></div>
        <div class="gv-helpw"><button class="icon-btn sm" id="gvHelpBtn" title="Cú pháp lọc" aria-expanded="false">?</button><div class="gv-pop gv-help" id="gvHelp" hidden></div></div>
        <div class="seg gv-hf" id="gvHealth" role="group" aria-label="Lọc theo tình trạng"></div>
        <div class="gv-nsw" id="gvNsWrap"></div>
        <div class="gv-colw" id="gvColWrap"></div>
        <span class="gv-count" id="gvCount"></span>
        <div class="spacer"></div>
        <label class="gv-size">Mỗi trang <select id="gvSize" aria-label="Số dòng mỗi trang">${[25, 50, 100, 200].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <nav class="gv-pages" id="gvPages" aria-label="Phân trang"></nav>
      </div>
      <div class="gv-active" id="gvActive" hidden></div>
      <div class="gv-wrap" tabindex="0" id="gvWrap" aria-label="Bảng tài nguyên"></div>
      <div class="gv-foot" id="gvFoot"><kbd>j</kbd>/<kbd>k</kbd> di chuyển · <kbd>Enter</kbd> mở · <kbd>d</kbd> describe · <kbd>y</kbd> YAML · <kbd>l</kbd> log · <kbd>[</kbd>/<kbd>]</kbd> trang · <kbd>:</kbd> lệnh · <kbd>?</kbd> phím tắt</div>
    </div>
  </div>`;
/* sidebar groups (kinds not listed here fall into "Khác"; custom resources get their own group) */
const GRID_GROUPS = [
  ['Workload', ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet', 'ReplicationController', 'HorizontalPodAutoscaler', 'PodDisruptionBudget']],
  ['Mạng', ['Service', 'Ingress', 'IngressClass', 'NetworkPolicy',
    'Gateway', 'GatewayClass', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute',
    'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP', 'Middleware', 'MiddlewareTCP', 'TraefikService']],
  ['Cấu hình', ['ConfigMap', 'Secret', 'ResourceQuota', 'LimitRange']],
  ['Lưu trữ', ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'VolumeAttachment', 'CSIDriver', 'CSINode']],
  ['Phân quyền (RBAC)', ['ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding']],
  ['Cụm', ['Node', 'PriorityClass', 'RuntimeClass', 'Lease', 'APIService', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
    'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding', 'CertificateSigningRequest']],
];
gv.navQ = '';
gv.mini = store.get('grid2.mini') === '1';
gv.showEmpty = store.get('grid2.showEmpty') === '1';
gv.navFolded = new Set((() => { try { return JSON.parse(store.get('grid2.navFolded') || '[]'); } catch { return []; } })());
$('gvSize').value = String(gv.size);

const gkey = n => (n.group ? n.group + '/' + n.kind : n.kind); // custom kinds of different API groups stay apart
const numVal = s => { const m = /^(-?[\d.]+)\s*(m|Ki|Mi|Gi|k|M|G)?/.exec(s || ''); if (!m) return null;
  const f = { m: 0.001, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2]] || 1; return +m[1] * f; };
const cellText = (n, k) => { if (DERIVED[k] && (n.kind === 'Node' || n.info?.[k] == null)) return DERIVED[k](n); const v = n.info?.[k]; return k === 'node' && v && typeof shortNode === 'function' ? shortNode(v) : v ?? ''; };

/* ---------- sorting: several columns (shift+click), natural order, severity for status, empty values last ---------- */
const coll = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
// no sort chosen → neutral list order (like `kubectl get -A`), shown without any arrow
const NEUTRAL_ORDER = [['namespace', 1], ['name', 1]];
const sortsFor = tab => gv.sorts[tab] || [];
function compareBy(c) {
  if (c === 'status') return (a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || coll.compare(a.status || '', b.status || '');
  if (c === 'age') return (a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0); // ascending = newest first
  if (c === 'name') return (a, b) => coll.compare(a.name, b.name);
  if (c === 'namespace') return (a, b) => coll.compare(a.namespace || '', b.namespace || '');
  return (a, b) => {
    const x = cellText(a, c), y = cellText(b, c), nx = numVal(x), ny = numVal(y);
    return nx != null && ny != null ? nx - ny : coll.compare(String(x), String(y));
  };
}
const isEmpty = (n, c) => !['status', 'age', 'name', 'namespace'].includes(c) ? cellText(n, c) === '' || cellText(n, c) == null : c === 'namespace' && !n.namespace;
function sortRows(rows, sorts) {
  const fns = sorts.map(([c, d]) => [c, d, compareBy(c)]);
  return rows.sort((a, b) => {
    for (const [c, d, f] of fns) {
      const ea = isEmpty(a, c), eb = isEmpty(b, c);
      if (ea !== eb) return ea ? 1 : -1; // empty cells sink, whatever the direction
      const r = f(a, b) * d;
      if (r) return r;
    }
    return coll.compare(a.name, b.name);
  });
}

/* ---------- query language for the table search ----------
 *   word  -word  "two words"           free text (name, namespace, status, reason, every column, label values)
 *   col:value  col=value  col!=value  substring / exact / not, on a column (ns, status, node, ip, image, qos…)
 *   key=value  key!=value  key:value    label selector when "key" is not a column (app=cart, tier!=api)
 *   col>n col<n col>=n col<=n           numbers with units (restarts>3, cpu>100m, memory>=64Mi) or age (age<1h, age>2d)
 */
const COL_ALIAS = { ns: 'namespace', namespace: 'namespace', name: 'name', ten: 'name', status: 'status', st: 'status', age: 'age', tuoi: 'age',
  ip: 'podIP', image: 'images', img: 'images', images: 'images', restart: 'restarts', label: 'label', labels: 'label' };
function resolveCol(key, cols) {
  const k = key.toLowerCase();
  if (COL_ALIAS[k]) return COL_ALIAS[k];
  const hit = cols.find(([c, l]) => c.toLowerCase() === k || String(l).toLowerCase().replace(/\s+/g, '') === k);
  return hit ? hit[0] : null;
}
const DUR = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
function parseQuery(q, cols) {
  const toks = [], re = /(-?)(?:([\w.\/-]+?)(!=|>=|<=|=|:|>|<))?("[^"]*"?|\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (!m[0].trim()) continue;
    const [raw, neg, key, op, v] = m, value = v.replace(/^"|"$/g, '');
    if (!value && !key) continue;
    const col = key ? resolveCol(key, cols) : null;
    toks.push({ raw, neg: !!neg, key, op, value, col: col === 'label' ? null : col, label: key && (!col || col === 'label') ? (col === 'label' ? value.split('=')[0] : key) : null,
      labelValue: col === 'label' ? value.split('=')[1] ?? null : value });
  }
  return toks;
}
function colText(n, c) {
  if (c === 'name') return n.name; if (c === 'namespace') return n.namespace || ''; if (c === 'status') return `${n.status || ''} ${n.reason || ''}`;
  return String(cellText(n, c) ?? '');
}
function tokenMatches(n, t, cols) {
  const v = t.value.toLowerCase();
  let ok;
  if (!t.key) ok = [n.name, n.namespace, n.status, n.reason, ...cols.map(([c]) => cellText(n, c)), ...Object.values(n.labels || {})]
    .some(x => String(x ?? '').toLowerCase().includes(v));
  else if (t.label) {
    const lv = (n.labels || {})[t.label];
    ok = t.op === ':' && t.labelValue == null ? lv != null : t.op === '!=' ? lv !== t.labelValue : t.op === '=' ? lv === t.labelValue
      : lv != null && String(lv).toLowerCase().includes((t.labelValue || '').toLowerCase());
  } else if (['>', '<', '>=', '<='].includes(t.op)) {
    let x, y;
    if (t.col === 'age') { const d = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(t.value); x = Date.now() - (Date.parse(n.created) || 0); y = d ? +d[1] * DUR[d[2]] : NaN; }
    else { x = numVal(colText(n, t.col)); y = numVal(t.value); }
    ok = x != null && !isNaN(y) && (t.op === '>' ? x > y : t.op === '<' ? x < y : t.op === '>=' ? x >= y : x <= y);
  } else {
    const txt = colText(n, t.col).toLowerCase();
    ok = t.op === '=' ? txt.trim() === v : t.op === '!=' ? txt.trim() !== v : txt.includes(v);
    if (t.op === '!=') return ok; // "!=" already negates
  }
  return t.neg ? !ok : ok;
}
const HF = [['error', 'Lỗi'], ['warn', 'Cảnh báo'], ['ok', 'Ổn']];

/*
 * The graph card's status is a one-line summary ("ClusterIP · 1/1 endpoint", "2/2", "Opaque") because a card has no
 * columns. In the table that summary repeats other columns, so the status column says how the object is doing
 * instead; a status that means something of its own (a Pod phase, Bound, Ready, Complete, Pending…) stays.
 */
const IN_USE_KINDS = new Set(['ConfigMap', 'Secret', 'ServiceAccount', 'PersistentVolumeClaim']);
const READY_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Service', 'HorizontalPodAutoscaler']);
function gridStatus(n, cols) {
  const st = String(n.status || '');
  // bare numbers / very short values ("0", "1") would "match" almost any text: only compare meaningful values
  const vals = cols.map(([c]) => String(cellText(n, c) ?? '')).filter(v => v.length >= 3 && !/^\d+$/.test(v));
  const summary = /^\d+\/\d+/.test(st) || vals.some(v => st.includes(v) || v.includes(st.split(' · ')[0]));
  if (st && !summary && !/không dùng/.test(st)) return st;
  if (/không dùng/.test(st) || (n.health === 'unknown' && IN_USE_KINDS.has(n.kind))) return 'Không dùng';
  if (n.health === 'ok') return IN_USE_KINDS.has(n.kind) ? 'Đang dùng' : READY_KINDS.has(n.kind) ? 'Sẵn sàng' : 'Bình thường';
  if (n.reason) return n.reason;
  if (READY_KINDS.has(n.kind)) return n.health === 'error' ? 'Không pod nào sẵn sàng' : n.health === 'warn' ? 'Chưa đủ pod sẵn sàng' : 'Không chạy (0 replica)';
  return n.health === 'error' ? 'Lỗi' : n.health === 'warn' ? 'Cảnh báo' : '—';
}
/*
 * Column configuration per kind ("Cột" button): which columns show and in what order. Besides the kind's default
 * columns, any field the objects carry (info) can be added. Stored as the ordered list of visible keys; nothing
 * stored = the defaults. "Tên" is always first.
 */
const HIDDEN_INFO = new Set(['lỗi', 'podNodes', 'images', 'ports', 'replicas_', 'note']);
function columnModel(n0, list, nsCol) {
  const kindCols = (!n0.group || KNOWN_CR[n0.kind]) && KIND_COLS[n0.kind] ? KIND_COLS[n0.kind] : CUSTOM_COLS;
  const base = [...(nsCol ? [['namespace', 'Namespace']] : []), ['status', 'Trạng thái'], ...kindCols, ['age', 'Tuổi']];
  const seen = new Set(['name', ...base.map(c => c[0])]);
  const extras = [];
  for (const n of list) for (const k of Object.keys(n.info || {}))
    if (!seen.has(k) && !HIDDEN_INFO.has(k)) { seen.add(k); extras.push([k, typeof humanKey === 'function' ? humanKey(k) : k]); }
  const all = [...base, ...extras], label = new Map(all);
  const saved = gv.colCfg[gv.tabKey];
  const visible = (saved ? saved.filter(k => label.has(k)) : base.map(c => c[0]));
  return { kindCols, all, label, visible, dataCols: all.filter(([k]) => !['namespace', 'status', 'age'].includes(k)) };
}
function saveCols(keys) {
  if (keys) gv.colCfg[gv.tabKey] = keys; else delete gv.colCfg[gv.tabKey];
  store.set('grid2.cols', JSON.stringify(gv.colCfg));
}
function renderColPicker(model) {
  const on = new Set(model.visible);
  const order = [...model.visible, ...model.all.map(c => c[0]).filter(k => !on.has(k))];
  $('gvColWrap').innerHTML = `<button class="gv-nsbtn ${gv.colCfg[gv.tabKey] ? 'on' : ''}" id="gvColBtn" aria-expanded="${gv.colOpen}" title="Chọn cột hiển thị">
      <svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg><span>Cột</span><svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
    ${gv.colOpen ? `<div class="gv-pop gv-colpop"><div class="gv-colh">Kéo để đổi thứ tự · bỏ chọn để ẩn</div>
      <ul class="gv-collist" id="gvColList">
        <li class="fixed"><span class="grip"></span><label><input type="checkbox" checked disabled>Tên</label></li>
        ${order.map(k => `<li draggable="true" data-col="${esc(k)}" class="${on.has(k) ? '' : 'off'}"><span class="grip" aria-hidden="true">⋮⋮</span>
          <label><input type="checkbox" data-colv="${esc(k)}" ${on.has(k) ? 'checked' : ''}>${esc(model.label.get(k))}</label>
          ${model.dataCols.some(c => c[0] === k) && !model.kindCols.some(c => c[0] === k) ? '<small>thêm</small>' : ''}</li>`).join('')}
      </ul>
      <div class="gv-popf"><button class="linkbtn" data-colreset>Mặc định</button><span class="muted">${model.visible.length + 1}/${model.all.length + 1} cột</span></div></div>` : ''}`;
}
/* current list order (checked ones) → the visible columns */
function colsFromList() {
  return [...$('gvColList').querySelectorAll('li[data-col]')].filter(li => li.querySelector('input').checked).map(li => li.dataset.col);
}

const RATIO_COLS = new Set(['replicas', 'ready', 'updated', 'endpoints', 'pods']);
const hGroup = n => (n.health === 'error' || n.health === 'warn' ? n.health : 'ok');

/* ---------- data: the server filters, sorts and pages (TableController); the browser asks for one page at a time.
 * renderGrid() repaints with what it has and asks again (debounced); answers to an older request are dropped. ---------- */
gv.kinds = new Map(); gv.data = null; gv.dataKey = null; gv.seq = 0;
function gridScope() {
  const p = new URLSearchParams({ namespace: currentNs(), gq: (state.query || '').toLowerCase(), gh: state.health || '' });
  if (state.nsMulti) p.set('nss', [...state.nsMulti].join(','));
  return p;
}
function gridTabKey() { // the kind picked (a section key, or a plain kind from ":po")
  if (gv.kinds.has(gv.kind)) return gv.kind;
  for (const [k, x] of gv.kinds) if (x.sample.kind === gv.kind) return k;
  return gv.kind;
}
const getJson = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status + ' ' + r.statusText))));
let gridTimer = null;
function renderGrid() { paintGrid(); clearTimeout(gridTimer); gridTimer = setTimeout(gridLoad, 40); }
async function gridLoad() {
  const seq = ++gv.seq;
  try {
    const kinds = getJson('/api/table/kinds?' + gridScope());
    let table = null, key = null;
    if (gv.open) {
      key = gridTabKey();
      const p = gridScope();
      p.set('kind', key); p.set('q', gv.q); p.set('cols', JSON.stringify(gv.lastCols || [])); p.set('health', [...gv.health].join(','));
      p.set('nsf', JSON.stringify([...gv.ns])); p.set('sort', sortsFor(key).map(([c, d]) => c + ':' + d).join(','));
      p.set('page', gv.page); p.set('size', gv.size);
      if (gv.followSel && state.selected) p.set('sel', state.selected);
      table = getJson('/api/table?' + p);
    }
    const [k, t] = await Promise.all([kinds, table]);
    if (seq !== gv.seq) return; // a newer request is on its way
    gv.kinds = new Map(k.kinds.map(x => [x.key, x])); gv.kindsCtx = k.context;
    if (t) { gv.data = t; gv.dataKey = key; gv.page = t.page; gv.followSel = false; }
    gv.err = null;
  } catch (e) { if (seq === gv.seq) gv.err = e.message; }
  paintGrid();
}

function paintGrid() {
  if (!gv.kinds.size && !state.graph) return;
  // the sidebar lists every kind, also those with nothing in the chosen namespaces / filters (count 0, dimmed):
  // the built-in ones always, custom resources once seen in this cluster. sample(k) stands in for icon, label, info.
  const ctx = gv.kindsCtx ?? state.graph?.context;
  if (gv.seenCtx !== ctx) { gv.seenCtx = ctx; gv.seen = new Map(); }
  const groups = new Map(), samples = new Map(); // key → { n: objects, err: with errors }
  gv.kinds.forEach((x, k) => { const s = { ...x.sample, group: x.sample.group || null }; groups.set(k, { n: x.count, err: x.errors }); samples.set(k, s); gv.seen.set(k, s); });
  gv.seen.forEach((n, k) => { if (!groups.has(k)) { groups.set(k, { n: 0, err: 0 }); samples.set(k, n); } });
  const haveKind = new Set([...samples.values()].map(n => n.kind));
  GRID_GROUPS.forEach(([, ks]) => ks.forEach(k => { if (!haveKind.has(k)) { groups.set(k, { n: 0, err: 0 }); samples.set(k, { kind: k, id: '', name: '' }); } }));
  const cnt = k => groups.get(k).n;
  const sample = k => samples.get(k);
  const known = n => !n.group || KNOWN_CR[n.kind]; // built-in, or a well-known CR (Gateway API, Traefik)
  const rank = n => (!known(n) ? 1000 : GRID_ORDER.indexOf(n.kind) >= 0 ? GRID_ORDER.indexOf(n.kind) : 500);
  const order = [...groups.keys()].sort((a, b) => rank(sample(a)) - rank(sample(b)) || a.localeCompare(b));
  // the chosen kind (by section key, or by plain kind from ":po"); fall back to Pod / the first kind of the view
  let tab = groups.has(gv.kind) ? gv.kind : order.find(k => sample(k).kind === gv.kind);
  if (!tab) tab = order.includes('Pod') && cnt('Pod') ? 'Pod' : order.find(k => cnt(k)) || order[0];
  const label = k => kindInfo(sample(k)).label;
  const item = k => {
    const n0 = sample(k), bad = groups.get(k).err;
    return `<button role="tab" data-gtab="${esc(k)}" class="${gv.open && tab === k ? 'on' : ''} ${cnt(k) ? '' : 'empty'}" aria-selected="${tab === k}" style="--c:${kindInfo(n0).color}"
      title="${esc(label(k))} · ${cnt(k)}${n0.group ? ' · ' + esc(n0.group) : ''}${bad ? ` · ${bad} lỗi` : ''}"><span class="ic">${icon(iconKind(n0))}</span><span class="l">${esc(label(k))}</span>${bad ? '<i class="bad"></i>' : ''}<span class="n">${cnt(k)}</span></button>`;
  };
  const nq = gv.navQ.toLowerCase();
  const byGroupOrder = kinds => (a, b) => kinds.indexOf(sample(a).kind) - kinds.indexOf(sample(b).kind);
  const navGroups = GRID_GROUPS.map(([name, kinds]) => [name, order.filter(k => known(sample(k)) && kinds.includes(sample(k).kind)).sort(byGroupOrder(kinds))]);
  const listed = new Set(GRID_GROUPS.flatMap(g => g[1]));
  navGroups.push(['Khác', order.filter(k => known(sample(k)) && !listed.has(sample(k).kind))]);
  navGroups.push(['Tuỳ chỉnh (CRD)', order.filter(k => !known(sample(k)))]);
  const shown = k => gv.showEmpty || nq || cnt(k) || (gv.open && k === tab);
  const hiddenEmpty = navGroups.reduce((t, [, ks]) => t + ks.filter(k => !shown(k)).length, 0);
  $('gvTabs').innerHTML = appNavTop(nq) + navGroups.map(([name, ks]) => {
    const list = ks.filter(k => shown(k) && (!nq || label(k).toLowerCase().includes(nq) || k.toLowerCase().includes(nq)));
    if (!list.length) return '';
    if (gv.mini) return `<section class="gv-ng" title="${esc(name)}">${list.map(item).join('')}</section>`; // icon rail: no folding
    const folded = !nq && gv.navFolded.has(name);
    const total = list.reduce((t, k) => t + cnt(k), 0);
    const holdsTab = gv.open && list.includes(tab), bad = list.some(k => groups.get(k).err > 0);
    return `<section class="gv-ng ${folded ? 'folded' : ''}"><button class="gv-nh" data-navfold="${esc(name)}" aria-expanded="${!folded}" title="${folded ? 'Mở' : 'Gập'} nhóm ${esc(name)}">
      <span>${esc(name)}</span>
      ${folded && holdsTab ? `<i class="cur-dot" title="Đang xem ${esc(label(tab))}" style="--c:${kindInfo(sample(tab)).color}"></i>` : ''}${folded && bad ? '<i class="bad-dot"></i>' : ''}<span class="n">${total}</span><svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      ${folded ? '' : `<div class="gv-ni">${list.map(item).join('')}</div>`}</section>`;
  }).join('') + appNavTools(nq)
    + (!nq && !gv.mini && (hiddenEmpty || gv.showEmpty) ? `<button class="gv-empt" data-showempty>${gv.showEmpty ? 'Ẩn các loại không có tài nguyên' : `Hiện ${hiddenEmpty} loại không có tài nguyên`}</button>` : '');
  $('gvNav').classList.toggle('mini', gv.mini);
  document.body.classList.toggle('nav-mini', gv.mini);
  $('gvMini').title = $('gvMini').ariaLabel = gv.mini ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên';
  if (!gv.open) return; // closed: only the menu is kept up to date
  $('gvKindSel').innerHTML = navGroups.filter(g => g[1].length).map(([name, ks]) => `<optgroup label="${esc(name)}">${ks.map(k =>
    `<option value="${esc(k)}" ${tab === k ? 'selected' : ''}>${esc(label(k))} (${cnt(k)})</option>`).join('')}</optgroup>`).join('');
  $('gvInfoWrap').hidden = !tab;
  if (tab) {
    const t0 = sample(tab);
    if (gv.infoFor !== tab) { gv.infoFor = tab; gv.info = false; $('gvInfo').hidden = true; $('gvInfoBtn').setAttribute('aria-expanded', 'false'); }
    gv.infoNode = t0; gv.infoKinds = new Map(order.map(k => [sample(k).kind, k]));
    $('gvTitle').innerHTML = `<span class="k" style="--c:${kindInfo(t0).color}">${icon(iconKind(t0))}</span><b>${esc(label(tab))}</b>${t0.group ? `<span class="grp">${esc(t0.group)}</span>` : ''}`;
  }
  const d = gv.dataKey === tab ? gv.data : null;
  if (tab && !d) { // first answer for this kind still on its way
    if (gv.shownKey !== tab) { $('gvWrap').innerHTML = `<div class="tl-empty">${gv.err ? 'Không tải được: ' + esc(gv.err) : '<span class="spinner"></span>'}</div>`; $('gvPages').innerHTML = ''; $('gvCount').textContent = ''; gv.rows = []; gv.tabKey = tab; }
    return;
  }
  gv.shownKey = tab;
  if (tab && !d.kindTotal) { // a kind with nothing here: say so, keep the sidebar
    const where = state.nsMulti ? 'các namespace đang chọn' : isAll() ? 'cluster' : 'namespace ' + $('ns').value;
    const filtered = state.query || state.health;
    $('gvWrap').innerHTML = `<div class="tl-empty">Không có ${esc(kindInfo(sample(tab)).label)} nào ${filtered ? 'khớp bộ lọc' : 'trong ' + esc(where)}.</div>`;
    $('gvPages').innerHTML = ''; $('gvCount').textContent = ''; gv.rows = []; gv.tabKey = tab; return;
  }
  if (!tab) { $('gvWrap').innerHTML = `<div class="tl-empty">Không có tài nguyên nào khớp bộ lọc.</div>`; $('gvPages').innerHTML = ''; $('gvCount').textContent = ''; gv.rows = []; return; }

  const n0 = d.sample || sample(tab);
  const nsCol = d.nsCol;
  gv.tabKey = tab;
  const model = columnModel(n0, [{ info: Object.fromEntries(d.infoKeys.map(k => [k, 1])) }], nsCol);
  const cols = model.dataCols; // every data column, shown or not: the server's search and the status check look at all of them
  gv.lastCols = cols;
  const toks = parseQuery(gv.q, cols); // only for the filter chips: the rows come filtered from the server
  if (!nsCol) gv.ns.clear();
  renderGridFilters(tab, d.nsCounts, toks, d.hc, nsCol);
  renderColPicker(model);
  const valid = new Set(['name', ...model.visible]);
  const sorts = sortsFor(tab).filter(([c]) => valid.has(c));
  const pages = d.pages, total = d.total, page = d.rows, cur = d.page; // gv.page may already point at the page being fetched
  gv.rows = page;
  $('gvCount').innerHTML = total === d.kindTotal ? `${total} mục` : `<b>${total}</b> / ${d.kindTotal} mục`;

  const active = sorts;
  const sortIcon = c => {
    const i = active.findIndex(([x]) => x === c);
    if (i < 0) return '<svg class="i so idle" viewBox="0 0 24 24"><path d="M8 10l4-4 4 4M8 14l4 4 4-4"/></svg>';
    return `<svg class="i so" viewBox="0 0 24 24"><path d="${active[i][1] > 0 ? 'M7 14l5-5 5 5' : 'M7 10l5 5 5-5'}"/></svg>${active.length > 1 ? `<sup class="so-n">${i + 1}</sup>` : ''}`;
  };
  const th = (c, l, cls = '') => { const i = active.findIndex(([x]) => x === c);
    const only = active.length === 1 && i === 0;
    const click = !only ? (active.length > 1 && i >= 0 ? 'chỉ sắp xếp theo cột này' : 'sắp xếp tăng dần') : active[0][1] > 0 ? 'đổi sang giảm dần' : 'bỏ sắp xếp';
    const shift = i < 0 ? 'thêm làm tiêu chí phụ' : active[i][1] > 0 ? 'đổi tiêu chí này sang giảm dần' : 'bỏ tiêu chí này';
    return `<th data-sort="${c}" class="${cls} ${i >= 0 ? 'on' : ''}" aria-sort="${i >= 0 ? (active[i][1] > 0 ? 'ascending' : 'descending') : 'none'}" title="Bấm: ${click} · Shift+bấm: ${shift}"><span>${l}${sortIcon(c)}</span></th>`; };
  const mono = new Set(['podIP', 'clusterIP', 'images', 'image', 'tag', 'cpu', 'memory', 'cpuUsed', 'memUsed', 'internalIP', 'kubelet', 'ports', 'port', 'targetPort', 'nodePort', 'schedule', 'capacity', 'request', 'metricNow', 'metricTarget']);
  const cell = (n, c) => {
    const t = cellText(n, c);
    if (t === '' || t == null) return '<span class="dash">—</span>';
    if (c === 'restarts') { const r = +t || 0; return `<span class="rs ${r > 5 ? 'e' : r > 0 ? 'w' : ''}">${esc(t)}</span>`; }
    if (c === 'node') return `<span class="chipc" title="${esc(n.info?.node || t)}">${esc(t)}</span>`;
    const r = RATIO_COLS.has(c) && /^(\d+)\/(\d+)/.exec(t);
    if (r) {
      const pct = +r[2] ? Math.min(100, Math.round(100 * r[1] / r[2])) : 0;
      // a healthy object with an incomplete ratio (a Completed pod's 0/1) is finished, not failing: neutral grey
      const col = +r[2] === 0 || (pct < 100 && n.health === 'ok') ? 'var(--border-strong)' : pct === 100 ? 'var(--ok)' : pct === 0 ? 'var(--error)' : 'var(--warn)';
      return `<span class="ratio-c ${pct < 100 && n.health === 'error' ? 'r-bad' : pct < 100 && n.health === 'warn' ? 'r-warn' : ''}"><span class="mono">${esc(r[1] + '/' + r[2])}</span><span class="rb"><i style="width:${pct}%;background:${col}"></i></span></span>`;
    }
    return mono.has(c) ? `<span class="mono">${esc(t)}</span>` : esc(t);
  };
  const created = n => { const d = Date.parse(n.created); return isNaN(d) ? '' : new Date(d).toLocaleString('vi-VN'); };
  const quick = n => `<span class="ra">${typeof podsFor === 'function' && podsFor(n.id).length ? `<button data-row="logs" title="Log (l)"><svg class="i" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h13"/></svg></button>` : ''}
    <button data-row="describe" title="Describe (d)"><svg class="i" viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h6"/></svg></button>
    <button data-row="yaml" title="YAML (y)"><svg class="i" viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg></button></span>`;
  // live updates must not move what the user is reading: remember the first row in view and keep it at the same height
  const wrap = $('gvWrap'), anchor = gridAnchor(wrap);
  $('gvWrap').innerHTML = page.length ? `<table class="gv-t dense">
    <thead><tr>${th('name', 'Tên')}${model.visible.map(c => th(c, model.label.get(c), c === 'age' ? 'num age' : NUM_COLS.has(c) ? 'num' : '')).join('')}</tr></thead>
    <tbody>${page.map(n => `<tr data-id="${esc(n.id)}" class="h-${H(n.health)} ${state.selected === n.id ? 'sel' : ''}">
      <td class="nm"><div class="nmw"><span class="ki" style="--c:${kindInfo(n).color}">${icon(iconKind(n))}</span>
        <div class="nmt"><span class="t" title="${esc(n.name)}">${esc(n.name)}</span>
</div></div></td>
      ${model.visible.map((c, i) => {
        const last = i === model.visible.length - 1 ? quick(n) : ''; // the row's quick actions sit in the last cell
        if (c === 'namespace') return `<td class="txt nsc ${last ? 'lastc' : ''}" title="${esc(n.namespace || '')}">${n.namespace ? `<span class="cv">${esc(n.namespace)}</span>` : '<span class="dash">—</span>'}${last}</td>`;
        if (c === 'status') return `<td class="stc ${last ? 'lastc' : ''}"><span class="st" style="--c:var(--${H(n.health)})" title="${esc([n.status, n.reason].filter(Boolean).join(' — '))}"><i></i>${esc(gridStatus(n, model.kindCols))}</span>${last}</td>`;
        if (c === 'age') return `<td class="num age ${last ? 'lastc' : ''}" title="Tạo lúc ${esc(created(n))}"><span class="av">${esc(age(n.created) || '—')}</span>${last}</td>`;
        return `<td class="${NUM_COLS.has(c) ? 'num' : 'txt'} ${last ? 'lastc' : ''}" title="${esc(cellText(n, c))}"><span class="cv">${cell(n, c)}</span>${last}</td>`;
      }).join('')}${model.visible.length ? '' : `<td class="lastc">${quick(n)}</td>`}</tr>`).join('')}</tbody></table>`
    : `<div class="tl-empty">Không có ${esc(kindInfo(n0).label)} nào khớp bộ lọc. <button class="linkbtn" data-fclear>Xoá lọc</button></div>`;
  if (anchor) gridRestoreAnchor(wrap, anchor);

  // pagination: 1–50 / 230  [‹ 1 … 4 5 6 … 12 ›]
  const chev = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const btn = (p, label, cur, dis, aria) => `<button data-page="${p}" class="${cur ? 'on' : ''}" ${dis ? 'disabled' : ''} ${cur ? 'aria-current="page"' : ''} aria-label="${aria || 'Trang ' + label}">${label}</button>`;
  const nums = [];
  for (let p = 0; p < pages; p++) if (p === 0 || p === pages - 1 || Math.abs(p - cur) <= 1) nums.push(p); else if (nums[nums.length - 1] !== '…') nums.push('…');
  $('gvPages').innerHTML = pages > 1
    ? `<span class="pinfo"><b>${cur * d.size + 1}–${Math.min(total, (cur + 1) * d.size)}</b> / ${total}</span><div class="pgrp">`
      + btn(cur - 1, chev('M15 6l-6 6 6 6'), false, cur === 0, 'Trang trước')
      + nums.map(p => (p === '…' ? '<span class="gap">…</span>' : btn(p, p + 1, p === cur))).join('')
      + btn(cur + 1, chev('M9 6l6 6-6 6'), false, cur >= pages - 1, 'Trang sau') + '</div>'
    : '';
  gv.tab = tab;
  // the cursor follows its row (by id) when rows move, else the selected object, else stays in place
  const atCur = gv.cursorId ? page.findIndex(n => n.id === gv.cursorId) : -1, at = page.findIndex(n => n.id === state.selected);
  gv.cursor = atCur >= 0 ? atCur : at >= 0 ? at : Math.min(gv.cursor, Math.max(0, page.length - 1));
  markCursor(false);
}

/* health segment, namespace picker, help, and the row of active-filter chips */
function renderGridFilters(tab, nsCounts, toks, hc, nsCol) {
  $('gvHealth').innerHTML = HF.map(([h, l]) => `<button data-hf="${h}" class="${gv.health.has(h) ? 'on' : ''}" aria-pressed="${gv.health.has(h)}" ${hc[h] ? '' : 'disabled'}>
    <span class="dot" style="background:var(--${h})"></span>${l}<span class="hn">${hc[h]}</span></button>`).join('');
  if (nsCol) {
    const counts = new Map(Object.entries(nsCounts || {}));
    const list = [...counts.keys()].sort(coll.compare).filter(x => !gv.nsQ || x.toLowerCase().includes(gv.nsQ.toLowerCase()));
    const label = !gv.ns.size ? 'Mọi namespace' : gv.ns.size === 1 ? [...gv.ns][0] : `${gv.ns.size} namespace`;
    $('gvNsWrap').innerHTML = `<button class="gv-nsbtn ${gv.ns.size ? 'on' : ''}" id="gvNsBtn" aria-expanded="${gv.nsOpen}" title="Lọc theo namespace">
        <svg class="i" viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4z M3 12l9 4 9-4M3 17l9 4 9-4"/></svg><span>${esc(label)}</span><svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      ${gv.nsOpen ? `<div class="gv-pop gv-nspop"><input id="gvNsQ" type="search" placeholder="Tìm namespace…" value="${esc(gv.nsQ)}" autocomplete="off">
        <div class="gv-nslist">${list.map(x => `<label><input type="checkbox" data-nsv="${esc(x)}" ${gv.ns.has(x) ? 'checked' : ''}><span>${esc(x || '(không có)')}</span><small>${counts.get(x)}</small></label>`).join('') || '<p class="muted">Không có</p>'}</div>
        <div class="gv-popf"><button class="linkbtn" data-nsall>Bỏ chọn</button><span class="muted">${gv.ns.size || 'Không'} đã chọn</span></div></div>` : ''}`;
  } else $('gvNsWrap').innerHTML = '';
  const chips = [
    ...toks.map((t, i) => `<span class="fchip"><span class="fk">${t.key ? esc(t.key) + esc(t.op) : t.neg ? 'không có' : 'chứa'}</span>${t.neg && t.key ? '<b>không</b> ' : ''}${esc(t.value || '(có)')}<button data-ftok="${i}" aria-label="Bỏ điều kiện">×</button></span>`),
    ...[...gv.health].map(h => `<span class="fchip"><span class="fk">tình trạng</span>${esc(HF.find(x => x[0] === h)[1])}<button data-fhealth="${h}" aria-label="Bỏ">×</button></span>`),
    ...[...gv.ns].map(x => `<span class="fchip"><span class="fk">ns</span>${esc(x || '(không có)')}<button data-fns="${esc(x)}" aria-label="Bỏ">×</button></span>`),
  ];
  $('gvActive').hidden = !chips.length;
  $('gvActive').innerHTML = chips.length ? `<span class="fl">Lọc</span>${chips.join('')}<button class="linkbtn" data-fclear>Xoá lọc</button>` : '';
}
const HELP = [['ns:shop', 'namespace chứa “shop”'], ['status:crash', 'trạng thái / lý do chứa “crash”'], ['-kube', 'loại trừ mọi thứ chứa “kube”'],
  ['app=cart', 'label app đúng bằng cart'], ['tier!=api', 'label tier khác api'], ['restarts>3', 'so sánh số (restarts, keys…)'],
  ['cpu>100m', 'CPU / memory có đơn vị (m, Mi, Gi)'], ['age<1h', 'tạo trong 1 giờ qua (s, m, h, d, w)'], ['node:e68 qos:best', 'nhiều điều kiện = cùng thoả (AND)']];
function renderHelp() {
  $('gvHelp').innerHTML = `<div class="gh-t">Cú pháp lọc</div>${HELP.map(([q, d]) => `<button class="gh-row" data-hq="${esc(q)}"><code>${esc(q)}</code><span>${esc(d)}</span></button>`).join('')}
    <div class="gh-f">Tên cột dùng được: tên cột trong bảng (node, ip, qos, image, type, keys…), <code>ns</code>, <code>status</code>, <code>age</code>.<br>Sắp xếp: bấm tiêu đề cột; <kbd>Shift</kbd>+bấm để thêm tiêu chí phụ.</div>`;
}

/* scroll: only when the cursor was moved on purpose (keys, opening a row) — a live re-render must not move the list */
function markCursor(scroll = true) {
  const id = gv.rows[gv.cursor]?.id;
  gv.cursorId = id;
  $('gvWrap').querySelectorAll('tr[data-id]').forEach(tr => tr.classList.toggle('cur', tr.dataset.id === id));
  if (scroll) $('gvWrap').querySelector('tr.cur')?.scrollIntoView({ block: 'nearest' });
}
function gridMove(d) {
  if (!gv.rows.length) return;
  gv.cursor = Math.max(0, Math.min(gv.rows.length - 1, gv.cursor + d));
  markCursor();
}
function gridPage(d) { gv.page = Math.max(0, gv.page + d); gv.cursor = 0; gv.cursorId = null; renderGrid(); $('gvWrap').scrollTop = 0; }
function gridOpen(tab) {
  const n = gv.rows[gv.cursor]; if (!n) return;
  if (tab) { state.tab = tab; store.set('tab', tab); }
  showDetailRaw(n);
  renderGrid();
}
/* (i) next to the title: what the selected kind is (texts in kinddocs.js) */
function toggleKindInfo(on) {
  gv.info = on; $('gvInfo').hidden = !on; $('gvInfoBtn').setAttribute('aria-expanded', String(on));
  if (!on || !gv.infoNode) return;
  const n = gv.infoNode, k = kindInfo(n), d = (!n.group || KNOWN_CR[n.kind]) && KIND_DOCS[n.kind] || CUSTOM_DOC;
  const list = (t, xs) => (xs && xs.length ? `<div class="ki-s"><div class="ki-h">${t}</div><ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const rel = (d.rel || []).map(r => {
    const tab = gv.infoKinds.get(r), c = (KINDS[r] || KNOWN_CR[r] || CUSTOM).color;
    return tab ? `<button class="ki-rel" data-kgo="${esc(tab)}" style="--c:${c}" title="Xem danh sách ${esc(r)}">${icon(r)}${esc(r)}</button>`
               : `<span class="ki-rel off" style="--c:${c}" title="Cluster đang không có ${esc(r)} nào (theo bộ lọc hiện tại)">${icon(r)}${esc(r)}</span>`;
  }).join('');
  const url = d.doc ? (/^https?:/.test(d.doc) ? d.doc : K8S_DOCS + d.doc) : null;
  $('gvInfo').innerHTML = `<div class="ki-top"><span class="k" style="--c:${k.color}">${icon(iconKind(n))}</span>
      <div><b>${esc(n.kind)}</b><small>${esc(n.group ? n.group : n.namespace ? 'Tài nguyên trong namespace' : 'Tài nguyên cấp cluster')}</small></div>
      <button class="icon-btn sm ki-x" data-kclose title="Đóng (Esc)" aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <p class="ki-what">${esc(d.what)}</p>
    ${list('Dùng khi', d.use)}${list('Lưu ý', d.tips)}
    ${rel ? `<div class="ki-s"><div class="ki-h">Liên quan</div><div class="ki-rels">${rel}</div></div>` : ''}
    ${url ? `<a class="ki-doc" href="${esc(url)}" target="_blank" rel="noopener">Tài liệu chính thức <svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>` : ''}`;
}
/* menu sections above the resource kinds: Tổng quan (events, Helm) and Bảo mật (its three areas; the open one lists its items) */
const NAV_TL = '<svg class="i" viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>';
function navItem(attrs, { on, c, svg, label, n = '', bad = false, sub = false, empty = false }) {
  return `<button role="tab" data-gtab="" ${attrs} class="${on ? 'on' : ''} ${sub ? 'sub' : ''} ${empty ? 'empty' : ''}" aria-selected="${!!on}" style="--c:${c}"
    title="${esc(label)}${n !== '' ? ' · ' + n : ''}"><span class="ic">${svg}${bad ? '<i class="bad"></i>' : ''}</span><span class="l">${esc(label)}</span><span class="n">${n}</span></button>`;
}
function navSection(name, items, { cur = false, bad = false, total = '' } = {}) {
  if (!items.length) return '';
  if (gv.mini) return `<section class="gv-ng" title="${esc(name)}">${items.join('')}</section>`;
  const folded = gv.navFolded.has(name);
  return `<section class="gv-ng ${folded ? 'folded' : ''}"><button class="gv-nh" data-navfold="${esc(name)}" aria-expanded="${!folded}" title="${folded ? 'Mở' : 'Gập'} nhóm ${esc(name)}">
    <span>${esc(name)}</span>${folded && cur ? '<i class="cur-dot" style="--c:var(--accent)"></i>' : ''}${folded && bad ? '<i class="bad-dot"></i>' : ''}<span class="n">${total}</span>
    <svg class="i caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>${folded ? '' : `<div class="gv-ni">${items.join('')}</div>`}</section>`;
}
const NAV_GRAPH = '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.3 7.2l7.4.6M7 8.4l1.4 7.2M16.3 9.9l-5.6 6.4"/></svg>';
const hitNav = (nq, label) => !nq || label.toLowerCase().includes(nq);
/* top of the menu: the whole-cluster views (relationship map, events) */
function appNavTop(nq) {
  const graphOn = !document.querySelector('.app-view:not([hidden])');
  const tlOn = typeof tl !== 'undefined' && tl.open;
  const items = [];
  if (hitNav(nq, 'Sơ đồ quan hệ')) items.push(navItem('data-appv="graph"', { on: graphOn, c: '#8b5cf6', svg: NAV_GRAPH, label: 'Sơ đồ quan hệ' }));
  if (typeof tl !== 'undefined' && hitNav(nq, 'Sự kiện (events)')) items.push(navItem('data-appv="timeline"', { on: tlOn, c: '#6366f1', svg: NAV_TL, label: 'Sự kiện (events)' }));
  return navSection('Tổng quan', items, { cur: graphOn || tlOn });
}
/* bottom of the menu: tools working on top of the resources (Helm packages, security checks) */
function appNavTools(nq) {
  const items = [];
  if (typeof hm !== 'undefined' && hitNav(nq, 'Releases')) items.push(navItem('data-appv="helm"', { on: hm.open, c: '#0f62fe', svg: HELM_ICON(), label: 'Releases', n: hm.list.length || '' }));
  const sec = typeof secAppNav === 'function' ? secAppNav(nq, gv.mini) : { items: [] };
  return navSection('Helm', items, { cur: typeof hm !== 'undefined' && hm.open })
    + navSection('Kiểm tra bảo mật', sec.items, { cur: sec.cur, bad: sec.bad });
}

/* scroll anchoring for live re-renders: the first row below the sticky header, and how far below it is */
function gridAnchor(wrap) {
  if (!wrap || wrap.scrollTop <= 0) return null;
  const top = wrap.getBoundingClientRect().top + (wrap.querySelector('thead')?.offsetHeight || 0);
  for (const tr of wrap.querySelectorAll('tr[data-id]')) { const r = tr.getBoundingClientRect(); if (r.bottom > top) return { id: tr.dataset.id, off: r.top - top, top }; }
  return null;
}
function gridRestoreAnchor(wrap, a) {
  const tr = wrap.querySelector(`tr[data-id="${CSS.escape(a.id)}"]`);
  if (tr) wrap.scrollTop += tr.getBoundingClientRect().top - a.top - a.off;
}

function gridKind(k) { gv.kind = k; gv.page = 0; gv.cursor = 0; store.set('grid2.kind', k); renderGrid(); }

function setGrid(open) {
  gv.open = open;
  if (open) closeOtherViews('grid');
  $('grid').hidden = !open;
  $('gridBtn').classList.toggle('on', open);
  $('gridBtn').setAttribute('aria-selected', String(open));
  const u = new URL(location);
  // the grid is the default, so the graph gets the explicit ?view=graph (a reload keeps what the user was looking at)
  if (open) u.searchParams.delete('view'); else if (!u.searchParams.get('view')) u.searchParams.set('view', 'graph');
  history.replaceState(null, '', u);
  if (open) { gv.followSel = true; renderGrid(); $('gvWrap').focus(); }
}
VIEWS.grid = setGrid;

$('gridBtn').onclick = () => { if (!gv.open) setGrid(true); };
/* the left menu: kinds open the grid on that kind; the other entries open their view */
$('appNav').addEventListener('click', e => {
  const v = e.target.closest('[data-appv]');
  if (v) {
    if (v.dataset.appv === 'graph') showGraph();
    else if (v.dataset.appv === 'security') secOpen(v.dataset.stab, v.dataset.ssub || '*');
    else VIEWS[v.dataset.appv](true);
    return;
  }
  if (e.target.closest('[data-showempty]')) { gv.showEmpty = !gv.showEmpty; store.set('grid2.showEmpty', gv.showEmpty ? '1' : '0'); renderGrid(); return; }
  const tab = e.target.closest('[data-gtab]');
  if (tab) { if (!gv.open) setGrid(true); gridKind(tab.dataset.gtab); return; }
  const nf = e.target.closest('[data-navfold]');
  if (nf) {
    const g = nf.dataset.navfold;
    gv.navFolded.has(g) ? gv.navFolded.delete(g) : gv.navFolded.add(g);
    store.set('grid2.navFolded', JSON.stringify([...gv.navFolded])); renderGrid();
  }
});
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
  if (pg && !pg.disabled) { gv.page = +pg.dataset.page; gv.cursor = 0; gv.cursorId = null; renderGrid(); $('gvWrap').scrollTop = 0; return; }
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const c = th.dataset.sort, cur = [...sortsFor(gv.tab)];
    const i = cur.findIndex(([x]) => x === c);
    let next;
    if (e.shiftKey) { // add as a secondary key · flip · remove on the third click
      if (i < 0) next = [...cur, [c, 1]]; else if (cur[i][1] > 0) next = cur.map((x, j) => (j === i ? [c, -1] : x)); else next = cur.filter((_, j) => j !== i);
    } else next = cur.length === 1 && i === 0 ? (cur[0][1] > 0 ? [[c, -1]] : []) : [[c, 1]]; // plain click: this column only; ascending → descending → off
    if (next.length) gv.sorts[gv.tab] = next; else delete gv.sorts[gv.tab];
    store.set('grid2.sorts', JSON.stringify(gv.sorts)); gv.page = 0; renderGrid(); return;
  }
  const hf = e.target.closest('[data-hf]');
  if (hf) { const h = hf.dataset.hf; gv.health.has(h) ? gv.health.delete(h) : gv.health.add(h); gv.page = 0; renderGrid(); return; }
  if (e.target.closest('#gvColBtn')) { gv.colOpen = !gv.colOpen; renderGrid(); return; }
  const cv = e.target.closest('[data-colv]');
  if (cv) {
    let keys = colsFromList();
    // a column just switched on lands before "Tuổi" (age stays the last column), not after it
    const k = cv.dataset.colv, ai = keys.indexOf('age'), ki = keys.indexOf(k);
    if (cv.checked && ai >= 0 && ki > ai) { keys.splice(ki, 1); keys.splice(ai, 0, k); }
    saveCols(keys); renderGrid(); return;
  }
  if (e.target.closest('[data-colreset]')) { saveCols(null); renderGrid(); return; }
  if (e.target.closest('#gvNsBtn')) { gv.nsOpen = !gv.nsOpen; gv.nsQ = ''; renderGrid(); if (gv.nsOpen) $('gvNsQ')?.focus(); return; }
  const nsv = e.target.closest('[data-nsv]');
  if (nsv) { const x = nsv.dataset.nsv; nsv.checked ? gv.ns.add(x) : gv.ns.delete(x); gv.page = 0; renderGrid(); return; }
  if (e.target.closest('[data-nsall]')) { gv.ns.clear(); gv.page = 0; renderGrid(); return; }
  if (e.target.closest('#gvInfoBtn')) { toggleKindInfo(!gv.info); return; }
  if (e.target.closest('[data-kclose]')) { toggleKindInfo(false); $('gvInfoBtn').focus(); return; }
  const kg = e.target.closest('[data-kgo]');
  if (kg) { toggleKindInfo(false); gridKind(kg.dataset.kgo); return; }
  if (e.target.closest('#gvHelpBtn')) { gv.help = !gv.help; $('gvHelp').hidden = !gv.help; $('gvHelpBtn').setAttribute('aria-expanded', gv.help); if (gv.help) renderHelp(); return; }
  const hq = e.target.closest('[data-hq]');
  if (hq) { $('gvQ').value = hq.dataset.hq; gv.q = hq.dataset.hq; gv.help = false; $('gvHelp').hidden = true; gv.page = 0; renderGrid(); $('gvQ').focus(); return; }
  const ft = e.target.closest('[data-ftok]');
  if (ft) { const toks = parseQuery(gv.q, []); toks.splice(+ft.dataset.ftok, 1); gv.q = toks.map(t => t.raw).join(' '); $('gvQ').value = gv.q; gv.page = 0; renderGrid(); return; }
  const fh = e.target.closest('[data-fhealth]'); if (fh) { gv.health.delete(fh.dataset.fhealth); renderGrid(); return; }
  const fn = e.target.closest('[data-fns]'); if (fn) { gv.ns.delete(fn.dataset.fns); renderGrid(); return; }
  if (e.target.closest('[data-fclear]')) { gv.q = ''; $('gvQ').value = ''; gv.health.clear(); gv.ns.clear(); gv.page = 0; renderGrid(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  gv.cursor = gv.rows.findIndex(n => n.id === tr.dataset.id);
  const ra = e.target.closest('[data-row]');
  if (ra?.dataset.row === 'logs') { openLogsFor(tr.dataset.id); return; }
  gridOpen(ra ? ra.dataset.row : undefined);
});
$('gvQ').addEventListener('input', e => { gv.q = e.target.value.trim(); gv.page = 0; gv.cursor = 0; renderGrid(); });
$('gvQ').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.target.value = ''; gv.q = ''; renderGrid(); $('gvWrap').focus(); } if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); $('gvWrap').focus(); } });
$('grid').addEventListener('input', e => { if (e.target.id === 'gvNsQ') { gv.nsQ = e.target.value; const pos = e.target.selectionStart; renderGrid(); const q = $('gvNsQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } } });
/* drag & drop to reorder columns in the picker */
$('grid').addEventListener('dragstart', e => { const li = e.target.closest?.('#gvColList li[data-col]'); if (!li) return; gv.dragCol = li.dataset.col; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
$('grid').addEventListener('dragover', e => {
  const li = e.target.closest?.('#gvColList li[data-col]'); if (!li || !gv.dragCol || li.dataset.col === gv.dragCol) return;
  e.preventDefault();
  const src = $('gvColList').querySelector(`li[data-col="${CSS.escape(gv.dragCol)}"]`);
  const r = li.getBoundingClientRect();
  li.parentNode.insertBefore(src, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
});
$('grid').addEventListener('dragend', () => { if (!gv.dragCol) return; gv.dragCol = null; saveCols(colsFromList()); renderGrid(); });
document.addEventListener('pointerdown', e => {
  if (gv.colOpen && !e.target.closest('#gvColWrap')) { gv.colOpen = false; renderGrid(); }
  if (gv.nsOpen && !e.target.closest('#gvNsWrap')) { gv.nsOpen = false; renderGrid(); }
  if (gv.info && !e.target.closest('#gvInfoWrap')) toggleKindInfo(false);
  if (gv.help && !e.target.closest('.gv-helpw')) { gv.help = false; $('gvHelp').hidden = true; $('gvHelpBtn').setAttribute('aria-expanded', 'false'); }
});
// Esc closes the kind explanation before the global shortcuts see it
document.addEventListener('keydown', e => { if (e.key === 'Escape' && gv.info) { e.stopPropagation(); e.preventDefault(); toggleKindInfo(false); $('gvInfoBtn').focus(); } }, true);
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
  document.documentElement.classList.remove('booting'); // the view is open: the graph chrome may show again (where it belongs)
}
