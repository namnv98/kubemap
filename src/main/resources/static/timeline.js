'use strict';
/*
 * Events timeline: on top the warning reasons (click = filter) and the rate over time; below, one row per top owner
 * (Deployment, CronJob…; its objects fold out), each with its reasons spelled out and its events on a shared time axis:
 * repeated events as a band from first to last time, a pulsing dot when still happening. Normal-only groups go last.
 * Click a row (or a mark) to open that object in the detail panel on its Events tab.
 * Depends on app.js globals: $, esc, state, store, icon, iconKind, kindInfo, currentNs, isAll, showDetailRaw.
 */
/* full-canvas views (timeline, helm, security…): opening one closes the others */
const VIEWS = {};
function closeOtherViews(name) { for (const [k, set] of Object.entries(VIEWS)) if (k !== name) set(false); }
/* closing a view returns to the default one, the grid (the graph is opened explicitly: "1", ":graph", ?view=graph) */
function backToDefault() { if (VIEWS.grid) VIEWS.grid(true); }

const tl = { open: false, range: +(store.get('tl.range') || 3600), type: store.get('tl.type') || 'all', q: '', data: null, timer: null, now: 0 };
const TL_RANGES = [[900, '15 phút'], [3600, '1 giờ'], [10800, '3 giờ'], [0, 'Tất cả']];
const TL_BUCKETS = 72;

$('timeline').innerHTML = `
  <div class="tl-bar">
    <div class="hm-title"><span class="hm-logo tl"><svg class="i" viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg></span>Sự kiện</div>
    <div class="search sm"><svg class="i lead" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="tlQ" type="search" placeholder="Lọc theo tên, lỗi, nội dung…" autocomplete="off" aria-label="Lọc event"></div>
    <div class="seg" role="group" aria-label="Khoảng thời gian">${TL_RANGES.map(([s, l]) => `<button data-range="${s}">${l}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Loại event">
      <button data-type="all">Tất cả</button><button data-type="Warning"><i class="dot warn"></i>Chỉ Warning</button>
    </div>
    <span class="tl-sum" id="tlSum"></span>
    <div class="spacer"></div>
    <button class="icon-btn sm" id="tlClose" title="Đóng" aria-label="Đóng timeline"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div class="te-state" id="tlState"></div>
  <div class="te-top" id="tlTop"></div>
  <div class="te-head">
    <div class="te-lab te-legend"><span><i class="lg w"></i>Warning</span><span><i class="lg n"></i>Normal</span><span><i class="lg band"></i>lặp lại</span><span><i class="lg live"></i>đang diễn ra</span></div>
    <div class="tl-lane" id="tlAxis"></div>
  </div>
  <div class="tl-rows te-rows" id="tlRows"></div>
  <div class="tl-tip" id="tlTip" hidden></div>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <linearGradient id="teBandW" x1="0" x2="1"><stop offset="0" stop-color="var(--warn)" stop-opacity=".08"/><stop offset="1" stop-color="var(--warn)" stop-opacity=".5"/></linearGradient>
    <linearGradient id="teBandN" x1="0" x2="1"><stop offset="0" stop-color="var(--muted)" stop-opacity=".06"/><stop offset="1" stop-color="var(--muted)" stop-opacity=".32"/></linearGradient>
  </defs></svg>`;
tl.reason = null;
tl.exp = new Map();


/* node filter from the node bar: the node itself, its pods and what owns / routes to them */
function tlNodeScope() {
  if (!state.nodeFocus || typeof podsOnNode !== 'function') return null;
  const s = upstreamOf(podsOnNode(state.nodeFocus));
  s.add(state.nodeFocus);
  return s;
}


const tlAgo = ms => {
  const s = Math.max(0, Math.round((tl.now - ms) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' + (s % 60 && s < 600 ? (s % 60) + 's' : '') : Math.floor(s / 3600) + 'h' + (Math.floor(s / 60) % 60 ? (Math.floor(s / 60) % 60) + 'm' : '');
};
const tlClock = ms => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const tlNum = n => n.toLocaleString('vi-VN');
const tlShort = n => n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(n);
/* still happening: last seen within two minutes */
const tlLive = e => tl.now - e.last < 120000 && (e.count > 1 || e.type === 'Warning');

/* the object an event belongs under: follow "owns" edges up (Pod → ReplicaSet → Deployment, Pod → Job → CronJob);
 * objects already gone from the cluster (finished CronJob pods…) are matched by name instead */
function tlRootOf(id, kind, ns, name, known) {
  const owners = tl.owners;
  let cur = id;
  for (let i = 0; i < 6 && owners.has(cur); i++) cur = owners.get(cur);
  if (cur !== id) return cur;
  const has = (k, n) => known.has(`${k}/${ns}/${n}`);
  const strip = (n, re) => (re.test(n) ? n.replace(re, '') : null);
  if (kind === 'Pod') {
    const parent = strip(name, /-[a-z0-9]{5}$/);
    if (parent) {
      if (has('Job', parent)) return tlRootOf(`Job/${ns}/${parent}`, 'Job', ns, parent, known);
      if (has('ReplicaSet', parent)) return tlRootOf(`ReplicaSet/${ns}/${parent}`, 'ReplicaSet', ns, parent, known);
      const cj = strip(parent, /-\d{6,}$/); if (cj && has('CronJob', cj)) return `CronJob/${ns}/${cj}`;
      const dep = strip(parent, /-[a-z0-9]{6,10}$/); if (dep && has('Deployment', dep)) return `Deployment/${ns}/${dep}`;
    }
    const sts = strip(name, /-\d+$/); if (sts && has('StatefulSet', sts)) return `StatefulSet/${ns}/${sts}`;
  }
  if (kind === 'Job') { const cj = strip(name, /-\d{6,}$/); if (cj && has('CronJob', cj)) return `CronJob/${ns}/${cj}`; }
  if (kind === 'ReplicaSet') { const dep = strip(name, /-[a-z0-9]{6,10}$/); if (dep && has('Deployment', dep)) return `Deployment/${ns}/${dep}`; }
  return id;
}

/* reason chips: "BackOff ×13 324" — warnings first, then by how often */
function tlReasons(evs, max = 3) {
  const by = new Map();
  evs.forEach(e => { const k = e.type + '|' + e.reason; const r = by.get(k) || by.set(k, { reason: e.reason, w: e.type === 'Warning', n: 0, live: false }).get(k); r.n += e.count; r.live = r.live || tlLive(e); });
  const list = [...by.values()].sort((a, b) => b.w - a.w || b.n - a.n);
  const shown = list.slice(0, max).map(r => `<span class="te-rc ${r.w ? 'w' : ''}" title="${esc(r.reason)}: ${tlNum(r.n)} lần">${esc(r.reason)}${r.n > 1 ? ` <b>×${tlShort(r.n)}</b>` : ''}</span>`).join('');
  return shown + (list.length > max ? `<span class="te-rc more">+${list.length - max}</span>` : '');
}

/* ---- "Tình trạng hiện tại": what is wrong right now, read from the live objects (not from events, which can be
 * missing, late or expired): data/connection problems, unhealthy pods grouped by their app, workloads short of replicas */
const POD_STATE = {
  Terminating: ['đang bị xoá', 'Thường do vừa scale xuống hoặc cập nhật phiên bản. Kéo dài quá vài phút: node phản hồi chậm hoặc pod bị kẹt finalizer.'],
  Pending: ['chưa chạy được (Pending)', 'Chưa được xếp lên node: thường do cluster thiếu CPU/RAM hoặc không có node phù hợp.'],
  ContainerCreating: ['đang khởi tạo', 'Đang tải image hoặc gắn volume; kéo dài lâu: image lớn, registry chậm hoặc volume lỗi.'],
  CrashLoopBackOff: ['khởi động lại liên tục', 'Ứng dụng bị dừng ngay sau khi chạy — xem log lần chạy trước.'],
  ImagePullBackOff: ['không tải được image', 'Sai tên/tag image, hoặc thiếu quyền truy cập registry.'],
  ErrImagePull: ['không tải được image', 'Sai tên/tag image, hoặc thiếu quyền truy cập registry.'],
  CreateContainerConfigError: ['thiếu cấu hình', 'Thiếu ConfigMap/Secret mà container cần.'],
  OOMKilled: ['hết bộ nhớ', 'Container dùng quá giới hạn RAM nên bị kill — tăng memory limit hoặc sửa rò rỉ bộ nhớ.'],
  Error: ['bị lỗi', 'Container thoát với mã lỗi — xem log.'],
  Evicted: ['bị đẩy khỏi node', 'Node thiếu tài nguyên (đĩa / RAM) nên đuổi pod.'],
  Unknown: ['mất liên lạc', 'Không nhận được trạng thái từ node — node có thể đang gặp sự cố.'],
};
const podStateOf = n => POD_STATE[n.status] ? n.status : n.health === 'error' ? 'Error' : n.health === 'warn' && n.status !== 'Running' ? (n.status || 'Unknown') : null;
function renderState() {
  const box = $('tlState');
  if (!box) return;
  const g = state.graph, out = [];
  // 1. data problems first: everything below may be incomplete
  const warns = [...(g?.warnings || [])];
  if (tl.error) warns.unshift('Không tải được sự kiện: ' + tl.error);
  if (warns.length) {
    const slow = warns.some(w => /timeout|exceeded/i.test(w));
    out.push(`<div class="st-item bad"><i class="ic">!</i><div><b>${slow ? 'API server của cluster đang phản hồi chậm / quá tải' : 'Không lấy đủ dữ liệu từ cluster'}</b>
      <p>${slow ? 'Một số yêu cầu hết thời gian chờ (10 giây). Danh sách sự kiện và số liệu bên dưới có thể thiếu hoặc cũ — ' : ''}đang tự thử lại.</p>
      <details><summary>Chi tiết</summary><ul>${warns.map(w => `<li><code>${esc(w)}</code></li>`).join('')}</ul></details></div></div>`);
  }
  if (g) {
    const scope = tlNodeScope();
    const nodes = g.nodes.filter(n => !n.missing && nsKeep(n) && (isAll() || !n.namespace || n.namespace === currentNs()) && (!scope || scope.has(n.id)));
    tl.owners = new Map((g.edges || []).filter(e => e.type === 'owns').map(e => [e.target, e.source]));
    const known = new Set(g.nodes.map(n => n.id));
    // 2. unhealthy pods, per app
    const apps = new Map();
    nodes.filter(n => n.kind === 'Pod').forEach(p => {
      const st = podStateOf(p); if (!st) return;
      const root = tlRootOf(p.id, p.kind, p.namespace, p.name, known);
      const a = apps.get(root) || apps.set(root, { root, n: 0, by: new Map() }).get(root);
      a.n++; a.by.set(st, (a.by.get(st) || 0) + 1);
    });
    [...apps.values()].sort((a, b) => b.n - a.n).slice(0, 6).forEach(a => {
      const [k, ns, ...rest] = a.root.split('/'), states = [...a.by.entries()].sort((x, y) => y[1] - x[1]);
      const bad = states.some(([st]) => !['Terminating', 'ContainerCreating', 'Pending'].includes(st));
      const [top] = states[0];
      out.push(`<div class="st-item ${bad ? 'bad' : 'warn'}" data-goto="${esc(a.root)}"><i class="ic">${bad ? '!' : '…'}</i><div>
        <b>${esc(rest.join('/'))} <span class="k">${esc(k)}${isAll() && ns ? ' · ' + esc(ns) : ''}</span></b>
        <span class="cnts">${states.map(([st, c]) => `<span class="c ${['Terminating', 'ContainerCreating', 'Pending'].includes(st) ? 'w' : 'e'}">${c} pod ${esc((POD_STATE[st] || [st])[0])}</span>`).join('')}</span>
        <p>${esc((POD_STATE[top] || ['', 'Pod ở trạng thái ' + top + '.'])[1])}</p></div></div>`);
    });
    if (apps.size > 6) out.push(`<div class="st-more">+${apps.size - 6} ứng dụng khác có pod bất thường</div>`);
    // 3. workloads short of replicas (not already listed above)
    nodes.filter(n => ['Deployment', 'StatefulSet'].includes(n.kind) && !apps.has(n.id)).forEach(w => {
      const m = /^(\d+)\/(\d+)$/.exec(w.status || ''); if (!m || +m[1] >= +m[2]) return;
      out.push(`<div class="st-item warn" data-goto="${esc(w.id)}"><i class="ic">…</i><div><b>${esc(w.name)} <span class="k">${esc(w.kind)}${isAll() && w.namespace ? ' · ' + esc(w.namespace) : ''}</span></b>
        <span class="cnts"><span class="c w">${m[1]}/${m[2]} replica sẵn sàng</span></span><p>Chưa đủ số bản chạy mong muốn — đang khởi động, đang cập nhật, hoặc thiếu tài nguyên.</p></div></div>`);
    });
  }
  box.innerHTML = `<div class="te-card st-card ${out.length ? '' : 'ok'}"><div class="te-ct">Tình trạng hiện tại <span class="muted">theo trạng thái thật của tài nguyên, cập nhật liên tục</span></div>
    ${out.length ? `<div class="st-list">${out.join('')}</div>` : '<span class="te-ok"><svg class="i" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>Mọi pod và workload đang chạy bình thường</span>'}</div>`;
}

/* what a warning reason means, in plain words, and the raw messages behind it (numbers / names folded so that
 * "0/3 nodes are available: 3 Insufficient cpu" from 700 pods counts as one message) */
const REASON_VI = {
  FailedScheduling: 'Kubernetes không tìm được node để đặt pod. Thường do cluster thiếu CPU/RAM so với "requests" của pod, node bị taint, hoặc ràng buộc nodeSelector/affinity không khớp.',
  BackOff: 'Container dừng hoặc không tải được image nên Kubernetes chờ lâu dần rồi thử lại.',
  Failed: 'Một bước khởi chạy container thất bại (thường là tải image: sai tên/tag hoặc thiếu quyền registry).',
  Unhealthy: 'Liveness/readiness probe báo lỗi: ứng dụng chạy nhưng không trả lời kiểm tra sức khoẻ.',
  FailedMount: 'Không gắn được volume (thiếu ConfigMap/Secret, PVC chưa sẵn sàng, hoặc lỗi lưu trữ).',
  FailedAttachVolume: 'Không gắn được ổ đĩa vào node.',
  ProvisioningFailed: 'Không tạo được ổ đĩa cho PVC (StorageClass sai hoặc nhà cung cấp lưu trữ lỗi).',
  FailedCreate: 'Controller không tạo được pod (vượt ResourceQuota, sai cấu hình, thiếu quyền…).',
  FailedGetResourceMetric: 'HPA không đọc được số liệu CPU/RAM (metrics-server chưa sẵn sàng hoặc pod chưa có requests).',
  FailedComputeMetricsReplicas: 'HPA không tính được số replica vì thiếu số liệu.',
  Evicted: 'Pod bị đẩy khỏi node vì node thiếu tài nguyên (RAM, đĩa).',
  OOMKilling: 'Container dùng quá giới hạn RAM nên bị kill.',
  NodeNotReady: 'Node mất liên lạc hoặc không sẵn sàng; pod trên đó có thể bị dời đi.',
  FailedKillPod: 'Không dừng được pod (node chậm hoặc runtime lỗi).',
};
/* raw scheduler / kubelet messages → what they mean here and what to do */
const MSG_HINTS = [
  [/Too many pods/i, '<b>Node đã đầy số pod.</b> Mỗi node chỉ chạy tối đa một số pod (kubelet <code>maxPods</code>, mặc định 110). Số replica vượt sức chứa của cả cluster → giảm replicas, thêm node, hoặc tăng <code>maxPods</code>.'],
  [/Insufficient cpu/i, '<b>Thiếu CPU.</b> Tổng CPU "requests" của các pod vượt CPU còn trống trên node → giảm requests/replicas hoặc thêm node.'],
  [/Insufficient memory/i, '<b>Thiếu RAM.</b> Tổng RAM "requests" vượt RAM còn trống trên node → giảm requests/replicas hoặc thêm node.'],
  [/untolerated taint|had taint/i, '<b>Node có taint</b> mà pod không chịu được (ví dụ node master/control-plane) → thêm toleration hoặc dùng node khác.'],
  [/didn't match (Pod's )?node affinity|node selector/i, '<b>Không node nào khớp</b> nodeSelector / affinity của pod → kiểm tra label của node.'],
  [/unbound immediate PersistentVolumeClaims|persistentvolumeclaim .* not found/i, '<b>PVC chưa sẵn sàng</b> nên pod chưa được đặt → kiểm tra PVC / StorageClass.'],
  [/pull access denied|not found|manifest unknown|ErrImagePull|ImagePullBackOff/i, '<b>Không tải được image</b> → kiểm tra tên/tag image và quyền truy cập registry (imagePullSecrets).'],
  [/Liveness probe failed|Readiness probe failed/i, '<b>Probe báo lỗi</b> → ứng dụng chưa sẵn sàng hoặc cấu hình probe (cổng, đường dẫn, thời gian chờ) chưa đúng.'],
  [/secret .* not found|configmap .* not found/i, '<b>Thiếu Secret/ConfigMap</b> mà pod tham chiếu → tạo nó, hoặc sửa tên trong manifest.'],
  [/exceeded quota/i, '<b>Vượt ResourceQuota</b> của namespace → tăng quota hoặc giảm tài nguyên yêu cầu.'],
];
function tlExplain(reason, r) {
  const msgs = r.msgs;
  const hints = [...new Set(msgs.flatMap(m => MSG_HINTS.filter(([re]) => re.test(m.sample)).map(([, h]) => h)))];
  return `<div class="te-why"><div class="te-why-h"><b>${esc(reason)}</b> là gì?</div>
    <p>${esc(REASON_VI[reason] || 'Cảnh báo do Kubernetes ghi lại — xem nội dung chi tiết bên dưới.')}</p>
    <div class="te-why-h">Thông báo gốc thường gặp</div>
    <ul>${msgs.map(m => `<li><span class="n">×${tlShort(m.n)}</span><code>${esc(m.sample)}</code></li>`).join('')}</ul>
    ${hints.length ? `<div class="te-why-h">Nguyên nhân & cách xử lý</div><ul class="hints">${hints.map(h => `<li>${h}</li>`).join('')}</ul>` : ''}</div>`;
}

function renderTimeline() {
  if (!tl.open || !tl.data) return;
  renderState();
  const v = tl.data; // one page, filtered and grouped by the server (EventsController.timeline)
  const noData = !!tl.error || (state.graph?.warnings || []).some(w => /^events/i.test(w)); // events not readable right now
  document.querySelectorAll('#timeline [data-range]').forEach(b => b.classList.toggle('on', +b.dataset.range === tl.range));
  document.querySelectorAll('#timeline [data-type]').forEach(b => b.classList.toggle('on', b.dataset.type === tl.type));
  const W = Math.max(200, $('tlAxis').clientWidth);
  const start = v.start, span = Math.max(1, v.now - v.start);
  const x = t => Math.max(0, Math.min(W, (t - start) / span * W));

  // ---- top: warning reasons (click = filter) + rate chart
  const wr = new Map(v.reasons.map(r => [r.reason, r]));
  const chips = v.reasons.map(r =>
    `<button class="te-wr ${tl.reason === r.reason ? 'on' : ''}" data-reason="${esc(r.reason)}" title="${tlNum(r.n)} lần trên ${r.objs} đối tượng — bấm để chỉ xem lỗi này">
      ${r.live ? '<i class="live"></i>' : '<i></i>'}<b>${esc(r.reason)}</b><span class="n">×${tlShort(r.n)}</span><span class="o">${r.objs} đối tượng</span></button>`).join('');
  const BK = v.rate.normal.length, normal = v.rate.normal, warn = v.rate.warn;
  const perMin = v.rate.bucketMs / 60000, peak = Math.max(1, ...normal.map((v, i) => v + warn[i]));
  // smooth stacked areas (total = normal + warning, warning on top of the baseline), monotone-ish curve through bucket centres
  const CW = 600, CH = 56, bw = CW / BK;
  const smooth = ys => { const p = ys.map((y, i) => [i * bw + bw / 2, y]); p.unshift([0, p[0][1]]); p.push([CW, p[p.length - 1][1]]);
    let d = `M${p[0][0]},${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) { const [x0, y0] = p[i], [x1, y1] = p[i + 1], mx = (x0 + x1) / 2; d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`; }
    return d; };
  const yT = normal.map((v, i) => CH - (v + warn[i]) / peak * (CH - 4)), yW = warn.map(v => CH - v / peak * (CH - 4));
  const area = (ys, cls) => { const d = smooth(ys); return `<path d="${d} L${CW},${CH} L0,${CH} Z" class="a-${cls}"/><path d="${d}" class="l-${cls}"/>`; };
  const bars = area(yT, 'n') + (warn.some(v => v) ? area(yW, 'w') : '');
  const fmtRate = v => v >= 10 ? Math.round(v) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
  $('tlTop').innerHTML = `
    <div class="te-card te-reasons"><div class="te-ct">Lỗi nổi bật <span class="muted">${wr.size ? 'bấm để lọc' : ''}</span></div>
      <div class="te-wrs">${chips || (noData ? '<span class="te-nod">Không lấy được sự kiện từ cluster — chưa biết có cảnh báo hay không</span>' : '<span class="te-ok"><svg class="i" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>Không có cảnh báo nào trong khoảng này</span>')}
      ${tl.reason ? `<button class="linkbtn" data-reason="">Bỏ lọc “${esc(tl.reason)}”</button>` : ''}</div>
      ${tl.reason && wr.has(tl.reason) ? tlExplain(tl.reason, wr.get(tl.reason)) : ''}</div>
    <div class="te-card te-rate"><div class="te-ct">Tần suất <span class="muted">lần / phút · đỉnh ${fmtRate(peak / perMin)}</span></div>
      <svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" class="te-chart" role="img" aria-label="Tần suất sự kiện theo thời gian">${bars}</svg>
      <div class="te-cx"><span>${tlClock(start)}</span><span class="lgd"><i class="w"></i>Warning<i class="n"></i>Normal</span><span>bây giờ</span></div></div>`;

  // ---- axis with ticks (the same ticks are drawn as gridlines in every row)
  const steps = [60, 300, 600, 900, 1800, 3600, 7200, 21600].map(s => s * 1000);
  const step = steps.find(s => span / s <= 8) || steps[steps.length - 1];
  const tickXs = [];
  for (let t = Math.ceil(start / step) * step; t <= v.now; t += step) if (x(t) < W - 56) tickXs.push([x(t), tlClock(t)]); // keep clear of "bây giờ"
  $('tlAxis').innerHTML = `<svg width="${W}" height="24">${tickXs.map(([tx, l]) => `<g transform="translate(${tx},0)"><line y1="16" y2="24" class="tick"/><text y="12" text-anchor="middle">${l}</text></g>`).join('')}
    <text x="${W - 2}" y="12" text-anchor="end" class="nowt">bây giờ</text><line x1="${W - 0.5}" x2="${W - 0.5}" y1="16" y2="24" class="now"/></svg>`;
  const grid = RH => tickXs.map(([tx]) => `<line x1="${tx}" x2="${tx}" y1="0" y2="${RH}" class="gl"/>`).join('') + `<line x1="${W - 0.5}" x2="${W - 0.5}" y1="0" y2="${RH}" class="now"/>`;

  // ---- groups: one per top owner (Deployment, CronJob…), its objects inside — this page only
  const byId = new Map((state.graph?.nodes || []).map(n => [n.id, n]));
  const list = v.groups.map(g => ({ ...g, ev: g.lane, objs: g.objs.map(o => ({ ...o, ns: o.ns || null })) }));
  const total = v.occurrences;
  const nodeName = state.nodeFocus ? state.nodeFocus.slice(state.nodeFocus.lastIndexOf('/') + 1) : null;
  $('tlSum').innerHTML = `<b>${tlNum(v.events)}</b> sự kiện <span class="muted">(lặp tổng ${tlNum(total)} lần)</span> · <b class="w">${v.warnGroups}</b> nhóm có cảnh báo`
    + (nodeName ? ` <button class="tl-chip" id="tlNodeOff" title="Bỏ lọc theo node">node ${esc(shortNode(nodeName))} ×</button>` : '');
  if (!list.length) {
    $('tlRows').innerHTML = noData ? `<div class="tl-empty">Không lấy được sự kiện từ cluster (API server chậm hoặc mất kết nối) — xem “Tình trạng hiện tại” ở trên.</div>` : `<div class="tl-empty">Không có event nào ${tl.range ? 'trong khoảng thời gian này' : ''}${tl.q || tl.type !== 'all' || tl.reason ? ' khớp bộ lọc' : ''}.
      <div class="muted">API server chỉ giữ event khoảng 1 giờ (mặc định <code>--event-ttl</code>).</div></div>`;
    return;
  }

  tl.rowEvs = new Map();
  const RH = 44;
  const lane = (key, ev) => {
    tl.rowEvs.set(key, ev);
    const order = ev.map((e, i) => i).sort((a, b) => (ev[a].type === 'Warning') - (ev[b].type === 'Warning')); // warnings drawn last, on top
    const marks = order.map(i => { const e = ev[i];
      const w = e.type === 'Warning', cls = w ? 'w' : 'n', live = tlLive(e);
      const x1 = x(Math.max(e.first, start)), x2 = live ? W - 1 : x(e.last);
      const band = e.count > 1 && x2 - x1 > 2 ? `<rect x="${x1}" y="${RH / 2 - 3}" width="${x2 - x1}" height="6" rx="3" class="band ${cls}" fill="url(#teBand${w ? 'W' : 'N'})" data-i="${i}"/>` : '';
      return `${band}${live ? `<circle cx="${x2}" cy="${RH / 2}" r="9" class="halo"/>` : ''}<circle cx="${x2}" cy="${RH / 2}" r="${w ? 4.5 : 3.5}" class="mk ${cls} ${live ? 'live' : ''}" data-i="${i}"/>`;
    }).join('');
    return `<div class="tl-lane"><svg width="${W}" height="${RH}">${grid(RH)}${marks}</svg></div>`;
  };
  const objLabel = (o, sub, owner) => { const n = byId.get(o.id) || { kind: o.kind, name: o.name };
    return `<span class="k" style="--c:${kindInfo(n).color}">${icon(iconKind(n))}</span>
      <span class="te-t"><span class="te-n"><span class="nm" title="${esc(o.kind + ' ' + (o.ns ? o.ns + '/' : '') + o.name)}">${esc(o.name)}</span>${!sub && isAll() && o.ns ? `<span class="ns">${esc(o.ns)}</span>` : ''}${owner ? `<span class="own" title="Thuộc ${esc(owner)}">← ${esc(owner)}</span>` : ''}${o.gone ? '<span class="gone" title="Đối tượng không còn trong cluster">đã xoá</span>' : ''}</span>
      <span class="te-rcs">${tlReasons(o.evs)}</span></span>`; };
  let html = '', normalHeader = false;
  list.forEach(g => {
    if (!g.warn && !normalHeader) { normalHeader = true; html += `<div class="te-sep">Chỉ có sự kiện bình thường</div>`; }
    const [rk, rns, ...rn] = g.key.split('/'), rname = rn.join('/');
    if (g.objsTotal === 1) { // one object: a single row, its owner named next to it
      const o = g.objs[0], owner = o.id === g.key ? null : rname;
      html += `<div class="tl-row te-row ${g.live ? 'is-live' : ''} ${g.warn ? 'has-w' : ''} ${state.selected === o.id ? 'sel' : ''}" data-id="${esc(o.id)}" data-row="${esc(o.id)}">
        <div class="te-lab">${objLabel(o, false, owner)}</div>${lane(o.id, o.evs)}</div>`;
      return;
    }
    const open = tl.exp.has(g.key) ? tl.exp.get(g.key) : (g.warn > 0 && g.objsTotal <= 4);
    const root = { id: g.key, kind: rk, ns: rns, name: rname, evs: g.ev, gone: !byId.has(g.key) && !g.objs.some(o => o.id === g.key && !o.gone) };
    html += `<div class="tl-row te-row te-grp ${open ? 'open' : ''} ${g.live ? 'is-live' : ''} ${g.warn ? 'has-w' : ''}" data-id="${esc(g.key)}" data-row="${esc(g.key)}">
      <div class="te-lab"><button class="te-x" data-exp="${esc(g.key)}" aria-expanded="${open}" title="${open ? 'Thu gọn' : 'Mở'} ${g.objsTotal} đối tượng"><svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        ${objLabel(root)}<span class="te-cnt" title="${g.objsTotal} đối tượng có sự kiện">${g.objsTotal}</span></div>${lane(g.key, g.ev)}</div>`;
    if (open) {
      g.objs.forEach(o => {
        html += `<div class="tl-row te-row te-child ${state.selected === o.id ? 'sel' : ''}" data-id="${esc(o.id)}" data-row="${esc(o.id)}">
          <div class="te-lab">${objLabel(o, true)}</div>${lane(o.id, o.evs)}</div>`;
      });
      if (g.objsTotal > g.objs.length) html += `<div class="te-more">+${tlNum(g.objsTotal - g.objs.length)} đối tượng khác (đang hiện ${g.objs.length} cái có sự kiện gần nhất) — lọc theo tên để tìm</div>`;
    }
  });
  if (v.pages > 1) html += `<div class="te-pager"><span>Trang <b>${v.page + 1}</b> / ${v.pages} · ${tlNum(v.groupsTotal)} nhóm</span>
    <button class="btn sm" data-tlpage="${v.page - 1}" ${v.page ? '' : 'disabled'}>‹ Trước</button><button class="btn sm" data-tlpage="${v.page + 1}" ${v.page < v.pages - 1 ? '' : 'disabled'}>Sau ›</button></div>`;
  $('tlRows').innerHTML = html;
}

/* refresh: every 5 s for a normal cluster, slower when there are thousands of events (a few hundred KB each time),
 * and not while the tab is hidden */
function tlSchedule() {
  clearTimeout(tl.timer);
  if (!tl.open) return;
  const n = tl.data?.events || 0, every = n > 3000 ? 20000 : n > 1000 ? 10000 : 5000;
  tl.timer = setTimeout(async () => { if (!document.hidden) await loadTimeline(); tlSchedule(); }, every);
}
async function loadTimeline() {
  const seq = (tl.seq = (tl.seq || 0) + 1);
  const p = new URLSearchParams({ namespace: currentNs(), range: tl.range, type: tl.type, reason: tl.reason || '', q: tl.q, page: tl.page || 0, size: 40 });
  if (state.nsMulti) p.set('nss', [...state.nsMulti].join(','));
  try {
    const r = await fetch('/api/events/timeline?' + p);
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    const v = await r.json();
    if (seq !== tl.seq) return; // a newer request (filter changed) is on its way
    tl.data = v;
    tl.now = v.now;
    tl.page = v.page;
    tl.error = null;
    renderTimeline();
  } catch (e) {
    if (seq !== tl.seq) return;
    tl.error = e.message || 'lỗi mạng';
    if (tl.data) renderTimeline(); else { renderState(); $('tlRows').innerHTML = `<div class="tl-empty">Không tải được sự kiện: ${esc(tl.error)}</div>`; }
  }
}

function setTimeline(open) {
  tl.open = open;
  if (open) closeOtherViews('timeline');
  $('timeline').hidden = !open;
  $('tlBtn').classList.toggle('on', open);
  $('tlBtn').setAttribute('aria-selected', String(open));
  const u = new URL(location);
  if (open) u.searchParams.set('view', 'timeline'); else if (u.searchParams.get('view') === 'timeline') u.searchParams.delete('view');
  history.replaceState(null, '', u);
  clearTimeout(tl.timer);
  if (open) { renderState(); loadTimeline(); tlSchedule(); }
}

VIEWS.timeline = setTimeline;
// the status card follows every graph push, not only the (slower) event refresh
{ const _render = render; render = function (fit) { _render(fit); if (tl.open) renderState(); }; }
$('tlBtn').onclick = () => { if (!tl.open) setTimeline(true); };
$('tlClose').onclick = () => backToDefault();
$('timeline').addEventListener('click', e => {
  if (e.target.closest('#tlNodeOff')) { document.querySelector('#nodebar .nb.active')?.click(); return; }
  const rb = e.target.closest('[data-range]');
  if (rb) { tl.range = +rb.dataset.range; store.set('tl.range', String(tl.range)); tl.page = 0; loadTimeline(); return; }
  const tb = e.target.closest('[data-type]');
  if (tb) { tl.type = tb.dataset.type; store.set('tl.type', tl.type); tl.page = 0; loadTimeline(); return; }
  const sg = e.target.closest('.st-item[data-goto]');
  if (sg && !e.target.closest('details')) { const n = state.graph?.nodes.find(x => x.id === sg.dataset.goto); if (n) showDetailRaw(n); return; }
  const rs = e.target.closest('[data-reason]');
  if (rs) { tl.reason = rs.dataset.reason && tl.reason !== rs.dataset.reason ? rs.dataset.reason : null; tl.page = 0; loadTimeline(); return; }
  const pg = e.target.closest('[data-tlpage]');
  if (pg && !pg.disabled) { tl.page = +pg.dataset.tlpage; loadTimeline(); $('tlRows').scrollTop = 0; return; }
  const ex = e.target.closest('[data-exp]');
  if (ex) { const k = ex.dataset.exp, row = ex.closest('.te-grp'); tl.exp.set(k, !row.classList.contains('open')); renderTimeline(); return; }
  const row = e.target.closest('.tl-row');
  if (row) {
    const n = state.graph?.nodes.find(x => x.id === row.dataset.id);
    if (!n) return;
    if (e.target.closest('.mk, .band')) { state.tab = 'events'; store.set('tab', 'events'); }
    showDetailRaw(n);
    document.querySelectorAll('.tl-row.sel').forEach(r => r.classList.remove('sel'));
    row.classList.add('sel');
  }
});
$('tlQ').addEventListener('input', e => { tl.q = e.target.value.trim(); tl.page = 0; clearTimeout(tl.qTimer); tl.qTimer = setTimeout(loadTimeline, 250); });

/* tooltip on marks */
$('tlRows').addEventListener('mousemove', e => {
  const mk = e.target.closest('.mk, .band'), tip = $('tlTip');
  if (!mk) { tip.hidden = true; return; }
  const ev = tl.rowEvs?.get(mk.closest('.tl-row').dataset.row)?.[+mk.dataset.i];
  if (!ev) { tip.hidden = true; return; }
  tip.innerHTML = `<div class="h"><span class="ty ${ev.type === 'Warning' ? 'w' : ''}">${esc(ev.type)}</span><b>${esc(ev.reason)}</b>
      <span class="muted">${ev.count > 1 ? `×${tlNum(ev.count)} · từ ${tlAgo(ev.first)} trước → ${tlLive(ev) ? '<b class="lv">đang diễn ra</b>' : tlAgo(ev.last) + ' trước'}` : tlAgo(ev.last) + ' trước'}</span></div>
    <div class="m">${ev.fieldPath ? `<code>${esc(ev.fieldPath)}</code> ` : ''}${esc(ev.message)}</div>
    <div class="muted">${esc(ev.source)} · ${esc(ev.kind)} ${esc(ev.namespace ? ev.namespace + '/' : '')}${esc(ev.name)}</div>`;
  tip.hidden = false;
  const box = $('timeline').getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = e.clientX - box.left + 14, top = e.clientY - box.top + 14;
  if (left + tw > box.width - 8) left = e.clientX - box.left - tw - 14;
  if (top + th > box.height - 8) top = e.clientY - box.top - th - 10;
  tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
});
$('tlRows').addEventListener('mouseleave', () => { $('tlTip').hidden = true; });
new ResizeObserver(() => renderTimeline()).observe($('timeline'));
$('ns').addEventListener('change', () => { if (tl.open) loadTimeline(); });
if (new URLSearchParams(location.search).get('view') === 'timeline') setTimeline(true);
