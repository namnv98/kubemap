'use strict';
/*
 * Security view, written for people who are not Kubernetes security experts. Same frame as the grid view (grid.js):
 * its sections and items live in the app's left menu (grid.js, via secAppNav; a select on narrow screens),
 * and on the right one sortable table for the picked item, with a level filter and an ⓘ popover explaining it.
 *  - "Cấu hình ứng dụng": all apps with problems (rows expand to their findings), or one check: the apps it hits + why / how to fix
 *  - "Truy cập từ ngoài": every way traffic can reach the cluster from outside, per mechanism
 *  - "Ai làm được gì": who (user / app / group / system) can do what, rows expand to roles and rules; "ai có thể…?" questions
 * All data is computed by the server from the informer cache. Click an object row to open it in the detail panel.
 * Depends on app.js ($, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw) and VIEWS (timeline.js).
 */
const secv = { open: false, tab: store.get('secv.tab') || 'workloads',
  subs: (() => { try { return { workloads: '*', entry: '*', rbac: '*', ...JSON.parse(store.get('secv.subs') || '{}') }; } catch { return { workloads: '*', entry: '*', rbac: '*' }; } })(),
  data: {}, sev: 'all', q: '', timer: null, exp: new Set(), canPreset: 'secrets', canFilter: null, info: false,
  sorts: {}, expandable: [] };
const SEV_RANK = { high: 0, medium: 1, low: 2, ok: 3 };
const LV = {
  workloads: { high: 'Nghiêm trọng', medium: 'Nên sửa', low: 'Khuyến nghị' },
  entry: { high: 'Mở công khai', medium: 'Cần kiểm tra', low: 'An toàn' },
  rbac: { high: 'Nguy hiểm', medium: 'Quyền rộng', ok: 'Bình thường' },
};
const lvColor = (tab, l) => l === 'high' ? 'var(--error)' : l === 'medium' ? 'var(--warn)' : l === 'ok' || tab === 'entry' ? 'var(--ok)' : 'var(--unknown)';
const lvH = l => l === 'high' ? 'error' : l === 'medium' ? 'warn' : 'ok'; // row accent, as the grid's h-error / h-warn

const SX_TABS = [
  ['workloads', 'Cấu hình ứng dụng', '#3b82f6', '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>'],
  ['entry', 'Truy cập từ ngoài', '#10b981', '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h12M11 8l4 4-4 4"/></svg>'],
  ['rbac', 'Ai làm được gì', '#f59e0b', '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/></svg>'],
];
const ISSUE_IC = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17h.01"/></svg>';
const TIP_IC = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
const CHEV = '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const SEC_ICON = '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>';

$('security').innerHTML = `
  <div class="gv-body" id="sxFrame">
    <div class="gv-main">
      <div class="gv-bar">
        <select class="gv-kindsel" id="sxSel" aria-label="Mục bảo mật"></select>
        <div class="gv-title" id="sxTitle"></div>
        <div class="gv-infow" id="sxInfoWrap"><button class="icon-btn sm gv-ibtn" id="sxInfoBtn" aria-expanded="false" aria-controls="sxInfo"
          title="Mục này là gì, sửa thế nào?"><svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg></button>
          <div class="gv-pop gv-kinfo" id="sxInfo" role="dialog" aria-label="Giải thích" hidden></div></div>
        <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="secQ" type="search" placeholder="Tìm theo tên, namespace, chi tiết…" autocomplete="off" aria-label="Tìm trong bảng"></div>
        <div class="seg gv-hf" id="sxSev" role="group" aria-label="Lọc theo mức độ"></div>
        <span class="gv-count" id="sxCount"></span>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="sxExpAll" data-expall="1" style="display:none">Mở tất cả</button>
        <button class="icon-btn sm" id="secClose" title="Đóng" aria-label="Đóng bảo mật"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="gv-active sx-sub" id="sxSub" hidden></div>
      <div class="gv-wrap" tabindex="0" id="secBody" aria-label="Bảng bảo mật"></div>
    </div>
  </div>`;

const kindIc = kind => ({ svg: icon(iconKind({ kind })), c: kindInfo({ kind }).color });
const openAttrs = o => `data-open="${esc(o.id)}" data-kind="${esc(o.kind)}" data-ns="${esc(o.namespace || '')}" data-name="${esc(o.name)}"`;
function openObject(id, kind, ns, name) {
  const n = state.graph?.nodes.find(x => x.id === id) || { id, kind, name, namespace: ns, health: 'unknown', status: '', info: {}, labels: {} };
  showDetailRaw(n);
}
const worstOf = ls => ls.reduce((a, l) => SEV_RANK[l] < SEV_RANK[a] ? l : a, 'ok');

/* ================================================================ workload checks */
/* plain-language explanation and fix for every check the server runs */
const CHECKS = {
  privileged: { t: 'Container chạy ở chế độ privileged', why: 'Container có toàn quyền như root trên máy chủ (node): truy cập mọi thiết bị, tắt mọi lớp cách ly. Bị chiếm container = bị chiếm cả node.',
    fix: 'securityContext:\n  privileged: false' },
  hostNetwork: { t: 'Pod dùng chung mạng với máy chủ', why: 'Pod mở cổng thẳng trên card mạng của node và thấy được traffic của node. Nếu pod bị chiếm, kẻ tấn công đứng ngay trong mạng của máy chủ.',
    fix: 'spec:\n  hostNetwork: false   # dùng Service để expose cổng' },
  hostPID: { t: 'Pod nhìn thấy tiến trình của máy chủ', why: 'Pod đọc được thông tin, biến môi trường của mọi tiến trình trên node và có thể kill chúng.', fix: 'spec:\n  hostPID: false' },
  hostIPC: { t: 'Pod dùng chung bộ nhớ IPC với máy chủ', why: 'Pod đọc/ghi được vùng nhớ chia sẻ của các tiến trình khác trên node.', fix: 'spec:\n  hostIPC: false' },
  hostPath: { t: 'Gắn thư mục của máy chủ vào pod', why: 'Container đọc/sửa trực tiếp file trên node. Gắn các thư mục như /, /etc, /var/run/docker.sock gần như tương đương chiếm quyền node.',
    fix: '# dùng PVC, emptyDir hoặc ConfigMap thay cho hostPath\n# nếu bắt buộc, chỉ cho đọc:\nvolumeMounts:\n- name: host\n  mountPath: /host\n  readOnly: true' },
  capabilities: { t: 'Cấp thêm quyền Linux nguy hiểm', why: 'Linux capabilities như NET_ADMIN (sửa cấu hình mạng) hay SYS_ADMIN (gần như root) mở rộng những gì container được làm trên node.',
    fix: 'securityContext:\n  capabilities:\n    drop: ["ALL"]\n    add: []   # chỉ thêm đúng cái thật sự cần' },
  saToken: { t: 'Pod mang theo token có quyền lớn', why: 'Kubernetes tự gắn token của ServiceAccount vào pod. Token này có quyền lớn trên cluster, nên ai chiếm được pod cũng có luôn những quyền đó.',
    fix: '# giảm quyền của ServiceAccount (mục "Ai làm được gì"), hoặc\n# nếu app không gọi Kubernetes API:\nspec:\n  automountServiceAccountToken: false' },
  root: { t: 'Container có thể chạy bằng root', why: 'Nếu ứng dụng có lỗ hổng, kẻ tấn công có quyền root bên trong container, dễ thoát ra máy chủ hơn.',
    fix: 'securityContext:\n  runAsNonRoot: true\n  runAsUser: 10001' },
  imageTag: { t: 'Image không ghi rõ phiên bản (:latest)', why: 'Mỗi lần pod khởi động lại có thể kéo về một bản image khác, khó biết đang chạy gì và dễ bị thay image độc.',
    fix: 'image: registry/app:1.4.2\n# hoặc chặt hơn: registry/app@sha256:…' },
  hostPort: { t: 'Mở cổng trực tiếp trên máy chủ (hostPort)', why: 'Container nhận traffic thẳng trên IP của node, đi vòng qua Service và NetworkPolicy.',
    fix: '# bỏ hostPort, expose qua Service:\nkind: Service\nspec:\n  type: ClusterIP   # hoặc LoadBalancer' },
  limits: { t: 'Không giới hạn RAM', why: 'Một container rò rỉ bộ nhớ có thể dùng hết RAM của node, làm các pod khác trên cùng node bị kill theo.',
    fix: 'resources:\n  requests:\n    memory: 128Mi\n  limits:\n    memory: 256Mi' },
  netpol: { t: 'Không có tường lửa giữa các pod (NetworkPolicy)', why: 'Mặc định mọi pod trong cluster gọi được tới nhau. Nếu một pod bị chiếm, kẻ tấn công đi tiếp sang pod này được.',
    fix: 'kind: NetworkPolicy\nspec:\n  podSelector: { matchLabels: { app: my-app } }\n  policyTypes: [Ingress]\n  ingress:\n  - from:\n    - podSelector: { matchLabels: { role: frontend } }' },
  privEsc: { t: 'Không chặn leo thang quyền', why: 'Tiến trình trong container có thể tự nâng quyền (qua setuid, sudo…). Nên chặn khi không cần.', fix: 'securityContext:\n  allowPrivilegeEscalation: false' },
  rootfs: { t: 'Ổ đĩa của container ghi được', why: 'Kẻ tấn công có thể ghi mã độc hoặc sửa chương trình bên trong container. Ứng dụng nên chỉ ghi vào thư mục được cấp riêng.',
    fix: 'securityContext:\n  readOnlyRootFilesystem: true\n# cần ghi tạm thì gắn emptyDir vào /tmp' },
  seccomp: { t: 'Chưa bật bộ lọc system call (seccomp)', why: 'seccomp chặn các lời gọi hệ thống hiếm dùng, thu hẹp đường tấn công vào kernel của máy chủ. Bật mặc định gần như không ảnh hưởng ứng dụng.',
    fix: 'securityContext:\n  seccompProfile:\n    type: RuntimeDefault' },
};
const SPECIFIC = new Set(['hostPath', 'capabilities', 'imageTag', 'hostPort', 'saToken']); // finding title carries the specifics


/* ================================================================ entry points */
const ENTRY_INFO = {
  LoadBalancer: ['Load balancer', 'Có địa chỉ IP riêng, thường là IP công khai: ai biết địa chỉ đều truy cập được, kể cả từ Internet.'],
  NodePort: ['Cổng trên mọi node (NodePort)', 'Truy cập được qua IP của bất kỳ node nào kèm số cổng. Lộ ra ngoài nếu node có IP công khai.'],
  Ingress: ['Tên miền (Ingress)', 'Website/API truy cập qua tên miền. Nên bật HTTPS (TLS) để mã hoá dữ liệu.'],
  externalIPs: ['IP ngoài gán tay (externalIPs)', 'Service nhận traffic trên địa chỉ IP được gán thủ công.'],
  hostPort: ['Cổng mở thẳng trên node (hostPort)', 'Container nhận traffic trực tiếp trên IP của node, không qua Service.'],
  hostNetwork: ['Pod dùng mạng của node', 'Mọi cổng mà pod mở đều nằm thẳng trên IP của node.'],
};


/* ================================================================ RBAC */
const DANGER = /cluster-admin|đọc Secret|leo quyền|exec/;
const FLAG_INFO = {
  'cluster-admin': 'Toàn quyền trên cả cluster: làm được mọi thứ.',
  wildcard: 'Được cấp quyền dạng * (mọi thao tác hoặc mọi loại tài nguyên), thường rộng hơn mức cần.',
  'đọc Secret': 'Đọc được Secret, nơi lưu mật khẩu, token và chứng chỉ.',
  'exec vào pod': 'Chạy được lệnh bên trong container của pod khác.',
  'leo quyền': 'Tự cấp thêm quyền cho mình hoặc giả danh người khác (escalate / bind / impersonate).',
  'tạo/sửa workload': 'Tạo/sửa được pod. Có thể chạy pod dùng ServiceAccount khác để mượn quyền của nó.',
  'nodes/proxy': 'Gọi thẳng vào kubelet trên node, đi vòng qua kiểm soát của API server.',
};
const KIND_VI = { User: 'Người dùng', ServiceAccount: 'Ứng dụng (ServiceAccount)', Group: 'Nhóm' };
const VERB_VI = { get: 'xem', list: 'liệt kê', watch: 'theo dõi', create: 'tạo', update: 'sửa', patch: 'sửa', delete: 'xoá', deletecollection: 'xoá hàng loạt',
  '*': 'mọi thao tác', escalate: 'nâng quyền', bind: 'gán role', impersonate: 'giả danh', proxy: 'proxy', use: 'sử dụng', approve: 'duyệt', sign: 'ký' };
const CAN_PRESETS = {
  secrets: ['đọc Secret (mật khẩu, token)', 'get', 'secrets', ''],
  exec: ['chạy lệnh trong pod (exec)', 'create', 'pods/exec', ''],
  delpods: ['xoá pod', 'delete', 'pods', ''],
  deploy: ['tạo / sửa Deployment', 'update', 'deployments', 'apps'],
  rbac: ['tự cấp quyền (tạo RoleBinding)', 'create', 'rolebindings', 'rbac.authorization.k8s.io'],
  nodes: ['xoá node', 'delete', 'nodes', ''],
  custom: ['tuỳ chỉnh…'],
};
const subjIcon = k => k === 'ServiceAccount' ? '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 10h6M9 14h4"/></svg>'
  : k === 'Group' ? '<svg class="i" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4"/></svg>'
  : '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>';
const verbCls = v => v === '*' ? 'v-all' : /^(create|update|patch|delete|deletecollection|escalate|bind|impersonate)$/.test(v) ? 'v-w' : 'v-r';
const lvlOf = s => s.flags.some(f => DANGER.test(f)) ? 'high' : s.flags.length ? 'medium' : 'ok';

const skey = sj => sj.kind + '/' + (sj.namespace || '') + '/' + sj.name;
const resName = r => r.nonResourceURLs.length ? r.nonResourceURLs
  : r.resources.flatMap(x => { const gs = r.apiGroups.filter(gp => gp); return gs.length ? r.apiGroups.map(gp => gp ? x + '.' + gp : x) : [x]; });
/* same shape as an issue group: rows on the left (what is granted, per role), explanation box on the right (why it matters, how to reduce) */
function subjectDetail(sj) {
  const byRole = new Map();
  sj.grants.forEach(g => { const k = g.roleKind + '/' + g.role + '@' + g.scope + '#' + g.binding; (byRole.get(k) || byRole.set(k, { g, rules: [] }).get(k)).rules.push(g); });
  const ruleLvl = r => r.verbs.includes('*') || r.resources.includes('*') ? 'high' : r.verbs.some(v => verbCls(v) === 'v-w') ? 'medium' : 'low';
  const roles = [...byRole.values()];
  return `<div class="sx-split">
    <div>${roles.map(({ g, rules }) => `
      <div class="sx-lbl">Vai trò <span class="nm">${esc(g.role)}</span> <span class="muted">${g.scope === 'cluster' ? 'toàn cluster' : 'chỉ namespace ' + esc(g.scope)} · ${esc(g.roleKind)}, gán qua ${esc(g.bindingKind)} ${esc(g.binding)}</span></div>
      ${rules.map(r => `<div class="sx-row static sx-rl"><i class="dot l-${ruleLvl(r)}"></i>
        <span class="vb">${[...new Map(r.verbs.map(v => [VERB_VI[v] || v, v])).entries()].map(([l, v]) => `<span class="${verbCls(v)}" title="${esc(r.verbs.filter(x => (VERB_VI[x] || x) === l).join(', '))}">${esc(l)}</span>`).join('')}</span>
        <span class="rs">${resName(r).map(x => x === '*' ? '<code class="v-all">mọi loại tài nguyên</code>' : `<code class="${x.startsWith('*') ? 'v-all' : ''}">${esc(x)}</code>`).join('')}${r.resourceNames.length ? `<span class="muted">chỉ: ${esc(r.resourceNames.join(', '))}</span>` : ''}</span>
      </div>`).join('')}`).join('')}
    </div>
    <div>
      <div class="sx-lbl">${sj.flags.length ? (lvlOf(sj) === 'high' ? 'Vì sao nguy hiểm' : 'Cần lưu ý') : 'Đánh giá'}</div>
      <div class="sx-box">${sj.flags.length ? sj.flags.map(f => `<p><i class="dot l-${DANGER.test(f) ? 'high' : 'medium'}"></i><span><b>${esc(f)}</b> — ${esc(FLAG_INFO[f] || '')}</span></p>`).join('')
        : '<p><i class="dot l-ok"></i><span>Không có quyền nào đáng lo.</span></p>'}
        ${sj.flags.length ? `<div class="sx-box-h">Cách giảm quyền</div><p class="t">Sửa ${roles.length > 1 ? 'các vai trò' : 'vai trò'} ${roles.map(x => `<code>${esc(x.g.role)}</code>`).join(', ')} để bỏ quyền thừa,
          hoặc xoá ${esc(roles[0].g.bindingKind)} nếu ${esc(KIND_VI[sj.kind]?.toLowerCase() || 'subject')} này không còn cần.${sj.system ? ' Đây là tài khoản hệ thống của Kubernetes — thường không nên sửa.' : ''}</p>` : ''}
      </div>
    </div></div>`;
}

async function runCan() {
  if (secv.canPreset === 'custom') { secv.canVerb = $('canVerb').value.trim(); secv.canRes = $('canRes').value.trim(); secv.canGroup = $('canGroup').value.trim(); }
  const [label, verb, resource, grp] = secv.canPreset === 'custom' ? [`${secv.canVerb} ${secv.canRes}`, secv.canVerb, secv.canRes, secv.canGroup] : CAN_PRESETS[secv.canPreset];
  if (!verb || !resource) return;
  const r = await fetch('/api/security/rbac/can?' + new URLSearchParams({ verb, resource, group: grp || '', namespace: currentNs() }));
  const list = await r.json().catch(() => []);
  secv.canFilter = { label, keys: new Set(list.map(a => a.kind + '/' + (a.namespace || '') + '/' + a.name)) };
  secv.sev = 'all';
  renderSecurity();
}


/* ================================================================ sidebar model: sections (one per tab) · items */
const ENTRY_KIND = { LoadBalancer: 'Service', NodePort: 'Service', externalIPs: 'Service', Ingress: 'Ingress', hostPort: 'Pod', hostNetwork: 'Pod' };
const RBAC_ITEMS = [['User', 'Người dùng'], ['ServiceAccount', 'Ứng dụng (ServiceAccount)'], ['Group', 'Nhóm'], ['system', 'Tài khoản hệ thống']];
const rbacIn = (sub, sj) => sub === '*' ? !sj.system : sub === 'system' ? sj.system : !sj.system && sj.kind === sub;

function navModel() {
  const d = secv.data, tabIc = t => SX_TABS.find(x => x[0] === t);
  const all = (t, label, n, bad, loading) => ({ key: '*', label, svg: tabIc(t)[3], c: tabIc(t)[2], n, bad, loading });
  const secs = [];
  // apps
  const wl = d.workloads, wItems = [];
  if (wl) {
    const hit = wl.filter(w => w.findings.length);
    wItems.push(all('workloads', 'Tất cả ứng dụng', hit.length, hit.some(w => w.findings.some(f => f.severity === 'high'))));
    const by = new Map();
    wl.forEach(w => w.findings.forEach(f => { const g = by.get(f.check) || by.set(f.check, { ws: new Set(), ls: [], t: f.title }).get(f.check); g.ws.add(w.id); g.ls.push(f.severity); }));
    [...by.entries()].map(([k, g]) => ({ k, g, sev: worstOf(g.ls) })).sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.g.ls.length - a.g.ls.length)
      .forEach(({ k, g, sev }) => wItems.push({ key: k, label: CHECKS[k]?.t || g.t, svg: sev === 'low' ? TIP_IC : ISSUE_IC, c: lvColor('workloads', sev), n: g.ls.length, bad: sev === 'high', sev }));
  } else wItems.push(all('workloads', 'Tất cả ứng dụng', '', false, true));
  secs.push(['workloads', wItems]);
  // entry points
  const en = d.entry, eItems = [];
  if (en) {
    eItems.push(all('entry', 'Tất cả điểm truy cập', en.length, en.some(e => e.severity === 'high')));
    const by = new Map(); en.forEach(e => (by.get(e.how) || by.set(e.how, []).get(e.how)).push(e));
    [...by.entries()].sort((a, b) => SEV_RANK[worstOf(a[1].map(e => e.severity))] - SEV_RANK[worstOf(b[1].map(e => e.severity))] || b[1].length - a[1].length)
      .forEach(([how, es]) => { const k = kindIc(ENTRY_KIND[how] || es[0].kind);
        eItems.push({ key: how, label: (ENTRY_INFO[how] || [how])[0], svg: k.svg, c: k.c, n: es.length, bad: es.some(e => e.severity === 'high') }); });
  } else eItems.push(all('entry', 'Tất cả điểm truy cập', '', false, true));
  secs.push(['entry', eItems]);
  // who can do what
  const rb = d.rbac, rItems = [];
  if (rb) {
    rItems.push(all('rbac', 'Tất cả (trừ hệ thống)', rb.filter(sj => !sj.system).length, rb.some(sj => !sj.system && lvlOf(sj) === 'high')));
    RBAC_ITEMS.forEach(([k, label]) => { const ss = rb.filter(sj => rbacIn(k, sj));
      rItems.push({ key: k, label, svg: k === 'system' ? SEC_ICON : subjIcon(k), c: '#f59e0b', n: ss.length, bad: k !== 'system' && ss.some(sj => lvlOf(sj) === 'high'), empty: !ss.length }); });
  } else rItems.push(all('rbac', 'Tất cả (trừ hệ thống)', '', false, true));
  secs.push(['rbac', rItems]);
  return secs;
}
const tabLabel = t => SX_TABS.find(x => x[0] === t)[1];

/* the narrow-screen select; the left menu (grid.js) asks secAppNav() for this section */
function renderNav(secs) {
  $('sxSel').innerHTML = secs.map(([tab, items]) => `<optgroup label="${esc(tabLabel(tab))}">${items.map(it =>
    `<option value="${esc(tab + '|' + it.key)}" ${secv.tab === tab && secv.subs[tab] === it.key ? 'selected' : ''}>${esc(it.label)}${it.n !== '' ? ` (${it.n})` : ''}</option>`).join('')}</optgroup>`).join('');
  if (typeof renderGrid === 'function') renderGrid();
}
/* menu entries: one per area; the open area lists its items (checks, ways in, kinds of account) under it */
function secAppNav(nq, mini) {
  const secs = navModel(), out = [];
  let bad = false;
  secs.forEach(([tab, items]) => {
    const [, label, c, svg] = SX_TABS.find(x => x[0] === tab), all = items[0];
    const here = secv.open && secv.tab === tab;
    bad = bad || !!all.bad;
    const subs = here && !mini ? items.slice(1).filter(it => !nq || it.label.toLowerCase().includes(nq)) : [];
    if (nq && !label.toLowerCase().includes(nq) && !subs.length) return;
    out.push(navItem(`data-appv="security" data-stab="${tab}" data-ssub="*"`, { on: here && secv.subs[tab] === '*', c, svg, label, n: all.loading ? '' : all.n, bad: all.bad }));
    subs.forEach(it => out.push(navItem(`data-appv="security" data-stab="${tab}" data-ssub="${esc(it.key)}"`,
      { on: secv.subs[tab] === it.key, c: it.c, svg: it.svg, label: it.label, n: it.n, bad: it.bad, sub: true, empty: it.empty || it.n === 0 })));
  });
  return { items: out, cur: secv.open, bad };
}
function secOpen(tab, sub) { if (!secv.open) { secv.tab = tab; secv.subs[tab] = sub; setSecurity(true); } pick(tab, sub); }

/* ================================================================ table (same markup as the grid: table.gv-t.dense) */
const nameTd = (name, ic, sub) => `<td class="nm"><div class="nmw"><span class="ki" style="--c:${ic.c}">${ic.svg}</span>
  <div class="nmt"><span class="t" title="${esc(name)}">${esc(name)}</span>${sub ? `<div class="why">${sub}</div>` : ''}</div></div></td>`;
const txtTd = (v, cls = 'txt') => `<td class="${cls}" title="${esc(v || '')}">${v ? `<span class="cv">${esc(v)}</span>` : '<span class="dash">—</span>'}</td>`;
const nsTd = v => txtTd(v, 'txt nsc');
const lvTd = (tab, l) => `<td class="stc"><span class="st" style="--c:${lvColor(tab, l)}"><i></i>${esc(LV[tab][l])}</span></td>`;
const numTd = (v, l) => `<td class="num">${v ? `<span class="sx-cnt" style="--c:${lvColor('workloads', l)}">${v}</span>` : '<span class="dash">—</span>'}</td>`;
const coll2 = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

/* cols: [{k, l, cls, v: row → sort value, td: row → <td>}]; rows sorted by the clicked column, default by level then name */
function table(view, cols, rows, opt) {
  const [sk, sd] = secv.sorts[view] || ['lv', 1];
  const col = cols.find(c => c.k === sk) || cols.find(c => c.k === 'lv') || cols[0];
  const name = cols[0].v;
  rows.sort((a, b) => { const x = col.v(a), y = col.v(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : coll2.compare(String(x ?? ''), String(y ?? ''));
    return (c * sd) || coll2.compare(name(a), name(b)); });
  const th = c => { const on = c.k === col.k;
    return `<th data-sort="${c.k}" class="${c.cls || ''} ${on ? 'on' : ''}" aria-sort="${on ? (sd > 0 ? 'ascending' : 'descending') : 'none'}" title="Bấm để sắp xếp"><span>${c.l}${on
      ? `<svg class="i so" viewBox="0 0 24 24"><path d="${sd > 0 ? 'M7 14l5-5 5 5' : 'M7 10l5 5 5-5'}"/></svg>` : '<svg class="i so idle" viewBox="0 0 24 24"><path d="M8 10l4-4 4 4M8 14l4 4 4-4"/></svg>'}</span></th>`; };
  const exp = opt.expand;
  secv.expandable = exp ? rows.map(opt.key) : [];
  return `<table class="gv-t dense sx-t"><thead><tr>${exp ? '<th class="xc" aria-label="Mở rộng"></th>' : ''}${cols.map(th).join('')}</tr></thead><tbody>${rows.map(r => {
    const k = exp ? opt.key(r) : '', open = exp && secv.exp.has(k);
    return `<tr class="h-${opt.h(r)} ${open ? 'xo' : ''}" ${exp ? `data-xrow="${esc(k)}" aria-expanded="${open}"` : opt.open(r)}>
      ${exp ? `<td class="xc"><span class="chev">${CHEV}</span></td>` : ''}${cols.map(c => c.td(r)).join('')}</tr>
      ${open ? `<tr class="sx-xr"><td colspan="${cols.length + 1}"><div class="sx-xb">${exp(r)}</div></td></tr>` : ''}`;
  }).join('')}</tbody></table>`;
}

const qMatch = (q, ...xs) => !q || xs.flat().some(x => String(x || '').toLowerCase().includes(q));
const LVCOL = tab => ({ k: 'lv', l: 'Mức độ', v: r => SEV_RANK[r._lv], td: r => lvTd(tab, r._lv) });

/* per view: rows (before the level filter), columns, row options, ⓘ text */
function viewOf(tab, sub, q) {
  const d = secv.data[tab];
  if (tab === 'workloads') {
    if (sub === '*') {
      const rows = d.filter(w => w.findings.length && qMatch(q, w.name, w.namespace, w.kind, w.findings.map(f => [f.title, CHECKS[f.check]?.t])))
        .map(w => { const n = { high: 0, medium: 0, low: 0 }; w.findings.forEach(f => n[f.severity]++);
          const top = [...w.findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
          return { ...w, _n: n, _lv: worstOf(w.findings.map(f => f.severity)), _top: CHECKS[top.check]?.t || top.title,
            _lvs: [...new Set(w.findings.map(f => f.severity))] }; });
      return { rows, cols: [
        { k: 'name', l: 'Ứng dụng', v: r => r.name, td: r => nameTd(r.name, kindIc(r.kind)) },
        { k: 'ns', l: 'Namespace', v: r => r.namespace || '', td: r => nsTd(r.namespace) },
        { k: 'kind', l: 'Loại', v: r => r.kind, td: r => txtTd(r.kind) },
        LVCOL(tab),
        { k: 'high', l: 'Nghiêm trọng', cls: 'num', v: r => -r._n.high, td: r => numTd(r._n.high, 'high') },
        { k: 'medium', l: 'Nên sửa', cls: 'num', v: r => -r._n.medium, td: r => numTd(r._n.medium, 'medium') },
        { k: 'low', l: 'Khuyến nghị', cls: 'num', v: r => -r._n.low, td: r => numTd(r._n.low, 'low') },
        { k: 'top', l: 'Vấn đề chính', v: r => r._top, td: r => txtTd(r._top) },
      ], opt: { key: r => r.id, expand: wlDetail }, lvOf: r => r._lvs };
    }
    const rows = d.flatMap(w => w.findings.filter(f => f.check === sub).map(f => ({ ...w, f, _lv: f.severity,
      _dt: SPECIFIC.has(f.check) ? f.title : f.detail || '' }))).filter(r => qMatch(q, r.name, r.namespace, r.kind, r._dt));
    return { rows, cols: [
      { k: 'name', l: 'Ứng dụng', v: r => r.name, td: r => nameTd(r.name, kindIc(r.kind)) },
      { k: 'ns', l: 'Namespace', v: r => r.namespace || '', td: r => nsTd(r.namespace) },
      { k: 'kind', l: 'Loại', v: r => r.kind, td: r => txtTd(r.kind) },
      LVCOL(tab),
      { k: 'dt', l: 'Chi tiết', v: r => r._dt, td: r => txtTd(r._dt, 'txt wide') },
    ], opt: { open: r => openAttrs(r) } };
  }
  if (tab === 'entry') {
    const rows = d.filter(e => (sub === '*' || e.how === sub) && qMatch(q, e.name, e.namespace, e.how, e.detail)).map(e => ({ ...e, _lv: e.severity }));
    return { rows, cols: [
      { k: 'name', l: 'Tài nguyên', v: r => r.name, td: r => nameTd(r.name, kindIc(r.kind)) },
      { k: 'ns', l: 'Namespace', v: r => r.namespace || '', td: r => nsTd(r.namespace) },
      { k: 'kind', l: 'Loại', v: r => r.kind, td: r => txtTd(r.kind) },
      ...(sub === '*' ? [{ k: 'how', l: 'Cách truy cập', v: r => (ENTRY_INFO[r.how] || [r.how])[0], td: r => txtTd((ENTRY_INFO[r.how] || [r.how])[0]) }] : []),
      LVCOL(tab),
      { k: 'dt', l: 'Chi tiết', v: r => r.detail || '', td: r => txtTd(r.detail, 'txt wide') },
    ], opt: { open: r => openAttrs(r) } };
  }
  const cf = secv.canFilter;
  const rows = d.filter(sj => (cf ? cf.keys.has(skey(sj)) : rbacIn(sub, sj))
      && qMatch(q, sj.kind, sj.name, sj.namespace, sj.flags, sj.grants.map(g => g.role))).map(sj => ({ ...sj, _lv: lvlOf(sj) }));
  return { rows, cols: [
    { k: 'name', l: 'Tên', v: r => r.name, td: r => nameTd(r.name, { svg: subjIcon(r.kind), c: lvColor('rbac', r._lv) }) },
    { k: 'kind', l: 'Loại', v: r => KIND_VI[r.kind] || r.kind, td: r => txtTd((KIND_VI[r.kind] || r.kind) + (r.system ? ' · hệ thống' : '')) },
    { k: 'ns', l: 'Namespace', v: r => r.namespace || '', td: r => nsTd(r.namespace) },
    LVCOL('rbac'),
    { k: 'flags', l: 'Quyền đáng chú ý', v: r => -r.flags.length, td: r => `<td class="txt wide">${r.flags.length ? r.flags.map(f => `<span class="sx-flag ${DANGER.test(f) ? 'hi' : ''}" title="${esc(FLAG_INFO[f] || '')}">${esc(f)}</span>`).join('') : '<span class="dash">—</span>'}</td>` },
    { k: 'rules', l: 'Quy tắc', cls: 'num', v: r => r.grants.length, td: r => `<td class="num">${r.grants.length}</td>` },
  ], opt: { key: r => 's:' + skey(r), expand: subjectDetail } };
}

function wlDetail(w) {
  const fs = [...w.findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  return `${fs.map(f => `<div class="sx-row static"><i class="dot" style="--c:${lvColor('workloads', f.severity)}"></i>
      <span class="tx"><b>${esc(CHECKS[f.check]?.t || f.title)}</b><span class="dt">${esc(SPECIFIC.has(f.check) ? f.title : (f.detail || ''))}${CHECKS[f.check] ? ' — ' + esc(CHECKS[f.check].why) : ''}</span></span>
      <button class="linkbtn" data-ssub="${esc(f.check)}" data-stab="workloads">Cách sửa</button></div>`).join('')}
    <div class="sx-actions"><button class="btn sm" ${openAttrs(w)}>Mở ${esc(w.kind)} ${esc(w.name)}</button></div>`;
}

/* ⓘ popover: what this item is, why it matters, how to fix (the grid's "what is this kind?" popover) */
function infoHtml(tab, sub, it) {
  const top = (title, small) => `<div class="ki-top"><span class="k" style="--c:${it.c}">${it.svg}</span><div><b>${esc(title)}</b><small>${small}</small></div>
    <button class="icon-btn sm ki-x" data-kclose aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  const levels = `<div class="ki-s"><div class="ki-h">Mức độ</div><ul>${Object.entries(LV[tab]).map(([l, t]) => `<li><b style="color:${lvColor(tab, l)}">${t}</b></li>`).join('')}</ul></div>`;
  if (tab === 'workloads' && sub !== '*') {
    const c = CHECKS[sub] || { t: it.label, why: '' };
    return top(c.t, esc(LV.workloads[it.sev] || '')) + `<p class="ki-what">${esc(c.why)}</p>`
      + (c.fix ? `<div class="ki-s"><div class="ki-h">Cách sửa — thêm vào manifest</div><pre class="sx-pre">${esc(c.fix)}</pre></div>` : '');
  }
  if (tab === 'workloads') return top('Cấu hình ứng dụng', 'Deployment, StatefulSet, DaemonSet, Job…')
    + `<p class="ki-what">Kiểm tra cách các ứng dụng được cấu hình. Bấm một dòng để xem các vấn đề của ứng dụng đó; chọn một vấn đề ở thanh bên để xem <b>vì sao nguy hiểm</b> và <b>cách sửa</b>. Ưu tiên sửa mục đỏ trước.</p>` + levels;
  if (tab === 'entry' && sub !== '*') { const [n, desc] = ENTRY_INFO[sub] || [sub, ''];
    return top(n, 'Đường vào cluster') + `<p class="ki-what">${esc(desc)}</p><div class="ki-s"><div class="ki-h">Nên làm</div><ul><li>Chỉ mở khi thật sự cần.</li><li>Giới hạn nguồn truy cập (firewall, loadBalancerSourceRanges, NetworkPolicy).</li><li>Dùng HTTPS cho web/API.</li></ul></div>`; }
  if (tab === 'entry') return top('Truy cập từ ngoài', 'Mọi đường traffic vào cluster')
    + `<p class="ki-what">Các con đường để người hoặc máy <b>bên ngoài cluster</b> gửi traffic vào ứng dụng. Kiểm tra mỗi mục có thật sự cần mở không, và đã giới hạn ai được truy cập chưa.</p>` + levels;
  return top(it.label, 'Phân quyền (RBAC)')
    + `<p class="ki-what">Ai (người dùng, ứng dụng, nhóm) <b>được phép làm gì</b> trong cluster. Bấm một dòng để xem vai trò và quy tắc, hoặc hỏi nhanh "ai có thể…?" ở thanh phía trên bảng.</p>`
    + `<div class="ki-s"><div class="ki-h">Quyền đáng chú ý</div><ul>${Object.entries(FLAG_INFO).map(([f, t]) => `<li><b>${esc(f)}</b> — ${esc(t)}</li>`).join('')}</ul></div>`;
}

function renderSecurity() {
  if (!secv.open) return;
  const secs = navModel();
  // a remembered item that no longer exists (check fixed, other namespace) falls back to "all"
  const sec = secs.find(s => s[0] === secv.tab) || secs[0];
  secv.tab = sec[0];
  let it = sec[1].find(x => x.key === secv.subs[secv.tab]);
  if (!it && secv.data[secv.tab]) { secv.subs[secv.tab] = '*'; it = sec[1][0]; }
  it = it || sec[1][0];
  renderNav(secs);
  const tab = secv.tab, sub = secv.subs[tab];
  $('sxTitle').innerHTML = `<span class="k" style="--c:${it.c}">${it.svg}</span><b>${esc(it.label)}</b>${sub !== '*' ? `<span class="grp">${esc(tabLabel(tab))}</span>` : ''}`;
  $('sxInfo').innerHTML = secv.data[tab] ? infoHtml(tab, sub, it) : '';
  renderSub(tab);
  if (!secv.data[tab]) { $('secBody').innerHTML = `<div class="tl-empty"><span class="spinner"></span></div>`; $('sxSev').innerHTML = ''; $('sxCount').textContent = ''; $('sxExpAll').style.display = 'none'; return; }
  const v = viewOf(tab, sub, secv.q.toLowerCase());
  const lvOf = v.lvOf || (r => [r._lv]);
  const cnt = {}; Object.keys(LV[tab]).forEach(l => cnt[l] = v.rows.filter(r => lvOf(r).includes(l)).length);
  if (secv.sev !== 'all' && !(secv.sev in cnt)) secv.sev = 'all';
  const rows = secv.sev === 'all' ? v.rows : v.rows.filter(r => lvOf(r).includes(secv.sev));
  $('sxSev').innerHTML = Object.entries(LV[tab]).map(([l, t]) => `<button data-sev="${l}" class="${secv.sev === l ? 'on' : ''}" aria-pressed="${secv.sev === l}" ${cnt[l] ? '' : 'disabled'}>
    <span class="dot" style="background:${lvColor(tab, l)}"></span>${t}<span class="hn">${cnt[l]}</span></button>`).join('');
  $('sxCount').innerHTML = rows.length === v.rows.length ? `${rows.length} mục` : `<b>${rows.length}</b> / ${v.rows.length} mục`;
  $('secBody').innerHTML = rows.length ? table(tab + '|' + (sub === '*' ? '*' : 'one'), v.cols, rows, { h: r => lvH(r._lv), ...v.opt })
    : `<div class="tl-empty sx-none">${SEC_ICON}<b>${v.rows.length ? 'Không có mục nào khớp bộ lọc' : tab === 'rbac' && secv.canFilter ? 'Không ai có quyền này' : 'Không có vấn đề nào'}</b>
        ${v.rows.length ? '<button class="linkbtn" data-fclear>Xoá lọc</button>' : ''}</div>`;
  const ex = secv.expandable.length > 0;
  $('sxExpAll').style.display = ex ? '' : 'none';
  if (ex) $('sxExpAll').textContent = secv.expandable.every(k => secv.exp.has(k)) ? 'Thu gọn tất cả' : 'Mở tất cả';
}

/* strip under the bar: the "who can…?" question on the RBAC tab */
function renderSub(tab) {
  const box = $('sxSub');
  if (tab !== 'rbac') { box.hidden = true; box.innerHTML = ''; return; }
  const cf = secv.canFilter, custom = secv.canPreset === 'custom';
  // keep typed values while re-rendering on every data refresh
  if (box.dataset.k === `${secv.canPreset}|${!!cf}|${cf?.keys.size}|${currentNs()}|${isAll()}` && !box.hidden) return;
  box.dataset.k = `${secv.canPreset}|${!!cf}|${cf?.keys.size}|${currentNs()}|${isAll()}`;
  box.hidden = false;
  box.innerHTML = `<div class="sx-can"><span class="fl">Ai có thể</span>
    <select id="canPreset" aria-label="Câu hỏi">${Object.entries(CAN_PRESETS).map(([k, p]) => `<option value="${k}" ${k === secv.canPreset ? 'selected' : ''}>${p[0]}</option>`).join('')}</select>
    ${custom ? `<input id="canVerb" value="${esc(secv.canVerb || 'get')}" aria-label="verb" placeholder="verb" class="w-s">
      <input id="canRes" value="${esc(secv.canRes || 'secrets')}" aria-label="resource" placeholder="resource">
      <input id="canGroup" value="${esc(secv.canGroup || '')}" aria-label="API group" placeholder="API group" title="API group — để trống = core">` : ''}
    <span>${isAll() ? 'ở bất kỳ namespace nào' : 'trong ns <b>' + esc(currentNs()) + '</b>'}?</span>
    <button class="btn sm primary" id="canGo">Kiểm tra</button>
    ${cf ? `<span class="sx-note">Đang chỉ xem <b>${cf.keys.size}</b> người/ứng dụng có thể ${esc(cf.label)} <button class="linkbtn" id="canClear">Bỏ lọc</button></span>` : ''}</div>`;
}

function toggleInfo(on) { secv.info = on; $('sxInfo').hidden = !on; $('sxInfoBtn').setAttribute('aria-expanded', String(on)); }
function pick(tab, sub) {
  if (secv.tab !== tab || secv.subs[tab] !== sub) { secv.sev = 'all'; toggleInfo(false); }
  secv.tab = tab; secv.subs[tab] = sub;
  if (tab !== 'rbac') secv.canFilter = null;
  store.set('secv.tab', tab); store.set('secv.subs', JSON.stringify(secv.subs));
  renderSecurity(); loadSecurity();
}

async function loadSecurity(tab = secv.tab) {
  const url = { workloads: '/api/security/workloads', entry: '/api/security/entrypoints', rbac: '/api/security/rbac' }[tab];
  try {
    const r = await fetch(url + '?namespace=' + encodeURIComponent(currentNs()));
    if (!r.ok) throw new Error(r.statusText);
    const d = (await r.json()).filter(nsKeep);
    if (JSON.stringify(d) === JSON.stringify(secv.data[tab])) return; // unchanged: keep scroll position and inputs
    secv.data[tab] = d;
    renderSecurity();
  } catch (e) { if (secv.tab === tab) $('secBody').innerHTML = `<div class="tl-empty">Không tải được: ${esc(e.message)}</div>`; }
}

function setSecurity(open) {
  secv.open = open;
  if (open) closeOtherViews('security');
  $('security').hidden = !open;
  $('secBtn').classList.toggle('on', open);
  $('secBtn').setAttribute('aria-selected', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'security'); else if (u.searchParams.get('view') === 'security') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearInterval(secv.timer);
  if (open) { renderSecurity(); ['workloads', 'entry', 'rbac'].forEach(t => loadSecurity(t)); secv.timer = setInterval(() => loadSecurity(), 15000); }
}
VIEWS.security = setSecurity;


$('secBtn').onclick = () => { if (!secv.open) setSecurity(true); };
$('secClose').onclick = () => backToDefault();
$('secQ').addEventListener('input', e => { secv.q = e.target.value.trim(); renderSecurity(); });
$('sxSel').addEventListener('change', e => { const [t, s] = e.target.value.split('|'); pick(t, s); });
$('security').addEventListener('click', e => {
  if (e.target.closest('#sxInfoBtn')) { toggleInfo(!secv.info); return; }
  if (e.target.closest('[data-kclose]')) { toggleInfo(false); $('sxInfoBtn').focus(); return; }
  if (secv.info && !e.target.closest('#sxInfoWrap')) toggleInfo(false);
  const t = e.target.closest('[data-stab]');
  if (t) { pick(t.dataset.stab, t.dataset.ssub || '*'); return; }
  const sv = e.target.closest('[data-sev]');
  if (sv) { secv.sev = secv.sev === sv.dataset.sev ? 'all' : sv.dataset.sev; renderSecurity(); return; }
  const th = e.target.closest('th[data-sort]');
  if (th) { const view = secv.tab + '|' + (secv.subs[secv.tab] === '*' ? '*' : 'one'), [k, d] = secv.sorts[view] || ['lv', 1];
    secv.sorts[view] = [th.dataset.sort, k === th.dataset.sort ? -d : 1]; renderSecurity(); return; }
  const o = e.target.closest('[data-open]');
  if (o) { openObject(o.dataset.open, o.dataset.kind, o.dataset.ns || null, o.dataset.name); return; }
  if (e.target.closest('[data-expall]')) { const all = secv.expandable.every(k => secv.exp.has(k));
    secv.expandable.forEach(k => all ? secv.exp.delete(k) : secv.exp.add(k)); renderSecurity(); return; }
  if (e.target.closest('[data-fclear]')) { secv.sev = 'all'; secv.q = ''; $('secQ').value = ''; renderSecurity(); return; }
  if (e.target.closest('#canClear')) { secv.canFilter = null; renderSecurity(); return; }
  if (e.target.closest('#canGo')) { runCan(); return; }
  const x = e.target.closest('tr[data-xrow]');
  if (x && !e.target.closest('.sx-xr')) { const k = x.dataset.xrow; secv.exp.has(k) ? secv.exp.delete(k) : secv.exp.add(k); renderSecurity(); }
});
$('security').addEventListener('change', e => {
  if (e.target.id === 'canPreset') { secv.canPreset = e.target.value; if (secv.canPreset === 'custom') { secv.canFilter = null; renderSecurity(); } else runCan(); }
});
$('security').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.closest('.sx-can input')) runCan();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-xrow], tr[data-open]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && secv.info) { e.stopPropagation(); e.preventDefault(); toggleInfo(false); $('sxInfoBtn').focus(); } }, true);
$('ns').addEventListener('change', () => { if (secv.open) { secv.data = {}; secv.canFilter = null; renderSecurity(); ['workloads', 'entry', 'rbac'].forEach(t => loadSecurity(t)); } });
if (new URLSearchParams(location.search).get('view') === 'security') setSecurity(true);
