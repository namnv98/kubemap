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
  if (d.t.length < 2) return block('Sử dụng tài nguyên (1 giờ)', null, `<p class="muted small">Đang thu thập số liệu (mỗi 15 giây một mẫu)…</p>`);
  const cpuF = v => (v >= 1000 ? (v / 1000).toFixed(2) : v + 'm'), memF = v => (v >= 1 << 30 ? (v / (1 << 30)).toFixed(1) + 'Gi' : Math.round(v / (1 << 20)) + 'Mi');
  const per = Object.entries(d.containers || {}).filter(([, s]) => s.t.length >= 2);
  return block('Sử dụng tài nguyên', null, `<div class="mx">${mxChart('CPU', d.t, d.cpuMilli, cpuF, d.now)}${mxChart('Memory', d.t, d.memBytes, memF, d.now)}</div>`)
    + (per.length > 1 ? block('Theo container', per.length, per.map(([name, s]) => `<div class="mx-ctr"><div class="mx-n">${esc(name)}</div>
        <div class="mx">${mxChart('CPU', s.t, s.cpuMilli, cpuF, d.now)}${mxChart('Memory', s.t, s.memBytes, memF, d.now)}</div></div>`).join('')) : '');
}

function mxChart(label, t, v, fmt, now) {
  // window = the data we have (at least 10 min, at most 1 h), so a fresh start isn't a sliver at the right edge
  const span = Math.min(3600000, Math.max(600000, now - t[0])), W = 300, H = 56, start = now - span;
  const max = Math.max(1, ...v) * 1.15;
  const x = ts => ((ts - start) / span) * W, y = val => H - (val / max) * H;
  const pts = t.map((ts, i) => `${x(ts).toFixed(1)},${y(v[i]).toFixed(1)}`);
  const area = `M${x(t[0]).toFixed(1)},${H} L${pts.join(' L')} L${x(t[t.length - 1]).toFixed(1)},${H} Z`;
  const cur = v[v.length - 1], peak = Math.max(...v), avg = v.reduce((a, b) => a + b, 0) / v.length;
  return `<div class="mx-c">
    <div class="mx-h"><b>${label}</b><span class="cur">${fmt(cur)}</span><span class="muted">đỉnh ${fmt(peak)} · TB ${fmt(Math.round(avg))}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label} trong 1 giờ qua, hiện ${fmt(cur)}, đỉnh ${fmt(peak)}">
      <path d="${area}" class="a"/><polyline points="${pts.join(' ')}" class="l" vector-effect="non-scaling-stroke"/></svg>
    <div class="mx-x"><span>${span >= 3600000 ? '1 giờ' : Math.round(span / 60000) + ' phút'} trước</span><span>bây giờ</span></div></div>`;
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
