'use strict';
/*
 * CPU / memory over the last hour (from the server's metrics-server poll history) in the Overview tab of nodes, pods
 * and workloads. overviewTab() calls mxBlock(n) synchronously with cached data; a fetch refreshes it every ~15s.
 * Depends on app.js ($, esc, state, showDetailRaw, block).
 */
const MX_KINDS = ['Node', 'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'];
const mx = { data: new Map(), loading: new Set() };

function mxBlock(n) {
  if (!MX_KINDS.includes(n.kind) || n.missing) return '';
  const d = mx.data.get(n.id);
  if (!d || Date.now() - d.at > 15000) mxLoad(n);
  if (!d) return '';
  if (!d.available && !d.t.length) return '';
  // a pod that never ran (image pull, scheduling…) or a workload with nothing ready will never get samples
  const idle = n.kind === 'Pod' ? !String(n.status || '').startsWith('Running') : /^0\//.test(n.info?.replicas || n.info?.ready || '');
  if (d.t.length < 2 && idle) return '';
  if (d.t.length < 2) return block('Sử dụng tài nguyên', null, `<p class="mx-wait"><span class="spinner"></span>Đang thu thập số liệu, mỗi 15 giây một mẫu…</p>`);
  const cpuF = v => (v >= 1000 ? (v / 1000).toFixed(2) : v + 'm'), memF = v => v >= 1 << 30 ? (v / (1 << 30)).toFixed(1) + 'Gi' : v >= 10 << 20 ? Math.round(v / (1 << 20)) + 'Mi' : v >= 1 << 20 ? (v / (1 << 20)).toFixed(1) + 'Mi' : Math.round(v / 1024) + 'Ki';
  const per = Object.entries(d.containers || {}).filter(([, s]) => s.t.length >= 2);
  return block('Sử dụng tài nguyên', null, `<div class="mx">${mxChart('CPU', d.t, d.cpuMilli, cpuF, d.now)}${mxChart('Memory', d.t, d.memBytes, memF, d.now)}</div>`)
    + (per.length > 1 ? block('Theo container', per.length, per.map(([name, s]) => `<div class="mx-ctr"><div class="mx-n">${esc(name)}</div>
        <div class="mx">${mxChart('CPU', s.t, s.cpuMilli, cpuF, d.now)}${mxChart('Memory', s.t, s.memBytes, memF, d.now)}</div></div>`).join('')) : '');
}

function mxChart(label, t, v, fmt, now) {
  // window = exactly the data we have (≥ 2 min, ≤ 1 h): a freshly started history fills the chart instead of
  // being squeezed into a sliver at the right edge
  const end = Math.max(now, t[t.length - 1]);
  const span = Math.min(3600000, Math.max(120000, end - t[0])), W = 300, H = 56, PAD = 3, start = end - span;
  const peak = Math.max(...v), max = Math.max(peak * 1.2, 1);
  const x = ts => Math.max(0, ((ts - start) / span) * W), y = val => H - PAD - (val / max) * (H - 2 * PAD);
  // break the line where samples are missing (app restarted, metrics-server down) instead of drawing a fake ramp
  const segs = [[]];
  t.forEach((ts, i) => { if (i && ts - t[i - 1] > 60000) segs.push([]); segs[segs.length - 1].push([x(ts), y(v[i])]); });
  const f = n => n.toFixed(1);
  const lines = segs.map(sg => sg.length === 1 ? [[sg[0][0] - 1, sg[0][1]], sg[0]] : sg)
    .map(sg => ({ line: sg.map(([a, b]) => `${f(a)},${f(b)}`).join(' '), area: `M${f(sg[0][0])},${H} L${sg.map(([a, b]) => `${f(a)},${f(b)}`).join(' L')} L${f(sg[sg.length - 1][0])},${H} Z` }));
  const cur = v[v.length - 1], avg = v.reduce((a, b) => a + b, 0) / v.length;
  const mins = Math.round(span / 60000);
  return `<div class="mx-c">
    <div class="mx-h"><span class="lab">${label}</span><span class="cur">${fmt(cur)}</span></div>
    <div class="mx-s">đỉnh <b>${fmt(peak)}</b> · TB <b>${fmt(Math.round(avg))}</b></div>
    <div class="mx-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} trong ${mins} phút qua, hiện ${fmt(cur)}, đỉnh ${fmt(peak)}">
        <line x1="0" x2="${W}" y1="${f(y(peak))}" y2="${f(y(peak))}" class="g" vector-effect="non-scaling-stroke"/>
        <line x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}" class="g0" vector-effect="non-scaling-stroke"/>
        ${lines.map(l => `<path d="${l.area}" class="a"/><polyline points="${l.line}" class="l" vector-effect="non-scaling-stroke"/>`).join('')}</svg>
      <i class="dot" style="left:${(x(t[t.length - 1]) / W * 100).toFixed(2)}%;top:${(y(cur) / H * 100).toFixed(2)}%"></i>
    </div>
    <div class="mx-x"><span>${mins >= 60 ? '1 giờ' : mins + ' phút'} trước</span><span>bây giờ</span></div></div>`;
}

async function mxLoad(n) {
  if (mx.loading.has(n.id)) return;
  mx.loading.add(n.id);
  try {
    const r = await fetch('/api/metrics/history?' + new URLSearchParams({ kind: n.kind, namespace: n.namespace || '', name: n.name }));
    if (!r.ok) return;
    const d = await r.json();
    const prev = mx.data.get(n.id);
    mx.data.set(n.id, { ...d, at: Date.now() });
    const changed = !prev || prev.t.length !== d.t.length || prev.t[prev.t.length - 1] !== d.t[d.t.length - 1];
    if (changed && state.selected === n.id && state.tab === 'overview') {
      const cur = state.graph?.nodes.find(x => x.id === n.id) || n;
      showDetailRaw(cur, true);
    }
  } catch { /* metrics are optional */ } finally { mx.loading.delete(n.id); }
}
