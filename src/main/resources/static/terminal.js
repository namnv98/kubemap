'use strict';
/*
 * Terminal into a container (drawer at the bottom of the canvas), over the /api/exec WebSocket.
 * Esc is NOT intercepted here: it belongs to the shell (vim, less…); close with the × button.
 * Depends on app.js / logs.js / actions.js globals: $, esc, state, toast, podsFor, closeLogs, isProd.
 */
const term = { ws: null, xterm: null, fit: null, ns: null, pod: null, ro: null };

function openTerminalFor(id) {
  const n = state.graph.nodes.find(x => x.id === id);
  if (!n) return;
  const pods = n.kind === 'Pod' ? [n] : podsFor(id).filter(p => p.status === 'Running' || p.health === 'ok');
  if (!pods.length) return toast('Không có pod nào đang chạy để mở terminal', 'err');
  openTerminal(pods[0].namespace, pods[0].name);
}

async function openTerminal(ns, pod) {
  if (typeof closeLogs === 'function' && !$('logs').hidden) closeLogs(); // one drawer at a time
  closeTerminal();
  term.ns = ns; term.pod = pod;
  $('term').hidden = false;
  document.querySelector('.canvas').classList.add('with-logs');
  $('termTitle').textContent = pod;
  $('termTitle').title = `${ns}/${pod}`;
  $('termCtx').innerHTML = `${esc(state.graph?.context || '?')} · ${esc(ns)}${isProd() ? ' · <b>PRODUCTION?</b>' : ''}`;
  $('termCtx').classList.toggle('prod', isProd());
  try {
    const r = await fetch(`/api/pods/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}/containers`);
    const cs = await r.json();
    if (!r.ok) throw new Error(cs.error || r.statusText);
    const running = cs.filter(c => !c.init && c.state === 'running');
    $('termContainer').innerHTML = (running.length ? running : cs.filter(c => !c.init)).map(c => `<option>${esc(c.name)}</option>`).join('');
  } catch (e) { return toast('Không lấy được container: ' + e.message, 'err'); }
  connectTerminal();
}

function connectTerminal() {
  disconnectTerminal();
  $('termBody').innerHTML = '';
  const dark = document.documentElement.dataset.theme !== 'light';
  const xt = term.xterm = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
    fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
    theme: dark ? { background: '#0b0e14', foreground: '#e6eaf2', cursor: '#7b97ff', selectionBackground: '#33416a' }
                : { background: '#ffffff', foreground: '#1b2130', cursor: '#3b57d6', selectionBackground: '#c9d4fb' },
  });
  term.fit = new FitAddon.FitAddon();
  xt.loadAddon(term.fit);
  xt.open($('termBody'));
  term.fit.fit();
  xt.focus();
  xt.writeln(`\x1b[2mĐang kết nối tới ${term.pod} [${$('termContainer').value}]…\x1b[0m`);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = new URLSearchParams({ namespace: term.ns, pod: term.pod, container: $('termContainer').value });
  const ws = term.ws = new WebSocket(`${proto}://${location.host}/api/exec?${qs}`);
  ws.binaryType = 'arraybuffer';
  const sendSize = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: xt.cols, r: xt.rows })); };
  ws.onopen = () => { $('termStatus').textContent = 'đã kết nối'; $('termStatus').className = 'on'; sendSize(); };
  ws.onmessage = m => xt.write(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  ws.onclose = () => { $('termStatus').textContent = 'đã ngắt'; $('termStatus').className = ''; };
  xt.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
  xt.onResize(sendSize);
  term.ro = new ResizeObserver(() => { try { term.fit.fit(); } catch {} });
  term.ro.observe($('termBody'));
}

function disconnectTerminal() {
  if (term.ro) { term.ro.disconnect(); term.ro = null; }
  if (term.ws) { try { term.ws.close(); } catch {} term.ws = null; }
  if (term.xterm) { term.xterm.dispose(); term.xterm = null; }
}

function closeTerminal() {
  disconnectTerminal();
  if ($('term')) $('term').hidden = true;
  if ($('logs').hidden) document.querySelector('.canvas').classList.remove('with-logs', 'logs-max');
  $('term')?.classList.remove('max');
}

$('termClose').onclick = closeTerminal;
$('termReconnect').onclick = connectTerminal;
$('termContainer').onchange = connectTerminal;
$('termMax').onclick = () => {
  $('term').classList.toggle('max');
  document.querySelector('.canvas').classList.toggle('logs-max', $('term').classList.contains('max'));
};
