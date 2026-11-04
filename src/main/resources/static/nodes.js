'use strict';
/*
 * Node bar: a strip under the filter bar with every cluster node, always visible (Node cards on the graph stay
 * available through the "Node" filter chip). Each node shows Ready state, role, how many pods of
 * the current view run on it, and CPU / memory usage. Clicking a node opens its details (Describe…) and dims every
 * pod that does not run on it (the view is not moved); clicking it again clears that.
 * Depends on app.js globals: $, esc, state, applyFocus, showDetailRaw, clearDetail, cy, isAll, placement.
 */
state.nodeFocus = null;

/* pods (graph ids) running on a node, from the runs-on edges of the current graph */
function podsOnNode(nodeId) {
  const s = new Set();
  (state.graph?.edges || []).forEach(e => { if (e.type === 'runs-on' && e.target === nodeId) s.add(e.source); });
  // workloads whose pods are outside the view (an ingress controller in kube-system…) say where their pods run
  const name = nodeId.slice(nodeId.lastIndexOf('/') + 1);
  (state.graph?.nodes || []).forEach(n => { if (n.info?.podNodes?.split(',').includes(name)) s.add(n.id); });
  return s;
}

/* GCE / EKS style FQDN hostnames ("k3s-master.asia-southeast1-a.c.project.internal") -> first label */
const shortNode = name => (/^[a-z0-9-]+\.[a-z0-9.-]+\.(internal|local|compute\.amazonaws\.com)$/i.test(name) ? name.split('.')[0] : name);

function meter(label, pct) {
  if (pct == null || pct === '') return `<span class="nb-m none" title="${label}: chưa có số liệu (metrics-server)"><i>${label}</i><b>—</b></span>`;
  const p = Math.max(0, Math.min(100, +pct));
  const lvl = p >= 90 ? 'error' : p >= 75 ? 'warn' : 'ok';
  return `<span class="nb-m" title="${label} đang dùng ${p}%"><i>${label}</i><span class="bar"><span style="width:${p}%;background:var(--${lvl})"></span></span><b>${p}%</b></span>`;
}

function renderNodebar(g) {
  const bar = $('nodebar');
  const nodes = (g.nodes || []).filter(n => n.kind === 'Node' && !n.missing)
    .sort((a, b) => (/control-plane|master/.test(b.info?.roles) - /control-plane|master/.test(a.info?.roles)) || a.name.localeCompare(b.name));
  if (state.nodeFocus && !nodes.some(n => n.id === state.nodeFocus)) state.nodeFocus = null;
  bar.hidden = !nodes.length;
  if (!nodes.length) return;
  const counts = new Map(nodes.map(n => [n.id, 0]));
  const visiblePods = new Set(g.nodes.filter(n => n.kind === 'Pod').map(n => n.id));
  g.edges.forEach(e => { if (e.type === 'runs-on' && counts.has(e.target) && visiblePods.has(e.source)) counts.set(e.target, counts.get(e.target) + 1); });
  const ready = nodes.filter(n => n.health !== 'error').length;
  const html = `<span class="label" title="${ready}/${nodes.length} node Ready">Node <b>${ready}/${nodes.length}</b></span>
    <div class="nb-list">${nodes.map(n => {
      const roles = n.info?.roles || 'worker';
      const cp = /control-plane|master/.test(roles);
      const active = state.nodeFocus === n.id;
      const tip = [n.name, n.status + (n.reason ? ' — ' + n.reason : ''), 'Vai trò: ' + roles, n.info?.internalIP && 'IP: ' + n.info.internalIP,
        n.info?.kubelet && 'Kubelet: ' + n.info.kubelet, n.info?.cpu && 'CPU: ' + n.info.cpu, n.info?.memory && 'Memory: ' + n.info.memory]
        .filter(Boolean).join('\n');
      return `<button class="nb ${active ? 'active' : ''}" data-node="${esc(n.id)}" style="--c:var(--${n.health === 'error' ? 'error' : n.health === 'warn' ? 'warn' : 'ok'})"
          title="${esc(tip)}" aria-pressed="${active}">
        <i class="dot"></i>
        <span class="nb-name">${esc(shortNode(n.name))}</span>
        <span class="nb-role ${cp ? 'cp' : ''}">${cp ? 'control-plane' : esc(roles)}</span>
        ${n.health !== 'ok' ? `<span class="nb-st">${esc(n.status)}</span>` : ''}
        <span class="nb-pods">${counts.get(n.id)} pod</span>
        ${meter('CPU', n.info?.cpuPct)}${meter('RAM', n.info?.memPct)}
        ${active ? '<span class="nb-x" aria-hidden="true">×</span>' : ''}
      </button>`;
    }).join('')}</div>`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
}

$('nodebar').addEventListener('click', e => {
  const b = e.target.closest('button[data-node]');
  if (!b || !state.graph) return;
  const id = b.dataset.node;
  if (state.nodeFocus === id) {
    state.nodeFocus = null;
    if (state.selected === id) clearDetail();
  } else {
    state.nodeFocus = id;
    const n = state.graph.nodes.find(x => x.id === id);
    if (n) showDetailRaw(n);
    // only dims what is not on this node: the viewport stays where the user left it
  }
  renderNodebar(state.graph);
  applyFocus();
});
