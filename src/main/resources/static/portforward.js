'use strict';
/*
 * Port-forward: "Port-forward" in the panel toolbar (Pod, Service, workloads) → pick a port → 127.0.0.1:<local>.
 * The top-bar chip lists active forwards (open / stop). Depends on app.js ($, esc, state) and actions.js (openModal, closeModal, toast).
 */
const PF_KINDS = ['Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'];
const pf = { list: [], remote: null, open: null };
fetch('/api/config').then(r => r.json()).then(c => { pf.remote = c.remote || null; }).catch(() => {});

/* remote access (another machine): HTTP proxy link + TCP tunnel commands, all on the remote-access port */
const remoteBase = () => pf.remote?.publicUrl || `${location.protocol}//${location.hostname}:${pf.remote?.port}`;
const PORT_HINT = { 5432: 'psql -h 127.0.0.1 -p {p} -U postgres', 3306: 'mysql -h 127.0.0.1 -P {p} -u root -p', 6379: 'redis-cli -h 127.0.0.1 -p {p}',
  27017: 'mongosh mongodb://127.0.0.1:{p}', 9092: 'kafka bootstrap 127.0.0.1:{p}', 5672: 'amqp://127.0.0.1:{p}', 9200: 'curl http://127.0.0.1:{p}' };
// browsers refuse these ports (ERR_UNSAFE_PORT), so never suggest them for a local tunnel end (e.g. 10080)
const UNSAFE_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const suggestLocal = f => { let p = f.targetPort >= 1024 ? f.targetPort : 18000 + f.targetPort; while (UNSAFE_PORTS.has(p)) p++; return p; };
function remoteHtml(f) {
  if (!pf.remote?.enabled) return `<p class="muted">Truy cập từ xa đang tắt (<code>k8s-studio.remote.port=0</code>).</p>`;
  const base = remoteBase(), ws = base.replace(/^http/, 'ws') + '/tunnel/' + f.id, lp = suggestLocal(f);
  const web = `${base}/pf/${f.id}/${f.token}/`;
  const cmd = (label, text, note = '') => `<div class="rc"><div class="rc-h">${label}${note ? `<span class="muted">${note}</span>` : ''}</div>
    <div class="rc-c"><code>${esc(text)}</code><button class="icon-btn sm" data-copy-text="${esc(text)}" title="Sao chép"><svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg></button></div></div>`;
  const local = pf.remote.address === '127.0.0.1' || pf.remote.address === 'localhost' || pf.remote.address === '::1';
  return `${local && !pf.remote.publicUrl ? `<p class="rc-warn">Cổng ${pf.remote.port} đang chỉ nghe trên ${esc(pf.remote.address)}: máy khác chưa vào được. Đặt <code>k8s-studio.remote.address=0.0.0.0</code> (nên đặt sau reverse proxy có TLS và khai báo <code>k8s-studio.remote.public-url</code>).</p>` : ''}
    ${cmd('Mở qua web', web, 'chỉ HTTP / HTTPS — mở trong trình duyệt')}
    ${cmd('Đường hầm TCP bằng Java 11+', `curl -fsSLO ${base}/connect.java && K8S_STUDIO_TOKEN=${f.token} java connect.java ${ws} - ${lp}`, 'mọi giao thức, không cần cài thêm')}
    ${cmd('Hoặc bằng websocat', `websocat -E -b -H='X-K8s-Studio-Token: ${f.token}' tcp-l:127.0.0.1:${lp} ${ws}`)}
    <p class="muted rc-n">Sau đó dùng ${PORT_HINT[f.targetPort] ? `<code>${esc(PORT_HINT[f.targetPort].replace('{p}', lp))}</code>` : `<code>127.0.0.1:${lp}</code>`} trên máy đó.
      Link và token hết hiệu lực khi dừng port-forward; ai có token đều vào được dịch vụ này.</p>`;
}

async function pfApi(method, path = '', body) {
  const r = await fetch('/api/portforward' + path, { method, headers: { 'Content-Type': 'application/json', 'X-K8s-Studio': '1' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

function pfTool(n) {
  if (n.missing || !PF_KINDS.includes(n.kind)) return '';
  if (n.kind === 'Pod' && !(n.status || '').startsWith('Running')) return '';
  return `<button class="tool" data-pf="open" title="Port-forward về 127.0.0.1"><svg class="i" viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>Port-forward</button>`;
}

async function openPortForward(n) {
  let ports;
  try { ports = await pfApi('GET', '/ports?' + new URLSearchParams({ kind: n.kind, namespace: n.namespace || '', name: n.name })); }
  catch (e) { toast(e.message, 'err'); return; }
  const existing = pf.list.filter(f => f.kind === n.kind && f.namespace === n.namespace && f.name === n.name);
  openModal(`
    <div class="m-head"><h3>Port-forward ${esc(n.kind)} ${esc(n.name)}</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    ${typeof contextBar === 'function' ? contextBar(n.namespace) : ''}
    <div class="m-body pf">
      ${ports.length ? `<div class="pf-ports">${ports.map((p, i) => `<label><input type="radio" name="pfport" value="${p.port}" ${i === 0 ? 'checked' : ''}>
        <b>${p.port}</b>/${esc(p.protocol || 'TCP')}${p.name ? ` <span class="muted">(${esc(p.name)})</span>` : ''} <span class="muted">${esc(p.note || '')}</span></label>`).join('')}
        <label><input type="radio" name="pfport" value="custom" ${ports.length ? '' : 'checked'}> Cổng khác <input id="pfCustom" type="number" min="1" max="65535" placeholder="vd. 8080"></label></div>`
        : `<p class="muted">Không khai báo port nào.</p><label>Cổng đích <input id="pfCustom" type="number" min="1" max="65535" placeholder="vd. 8080"></label>`}
      <label class="pf-local">Cổng local trên máy này <input id="pfLocal" type="number" min="1024" max="65535" placeholder="tự chọn"></label>
      <p class="muted">Mở trên máy chạy Kubemap (127.0.0.1). Máy khác vào qua “Mở qua web” hoặc đường hầm TCP trong danh sách port-forward. ${n.kind === 'Service' || n.kind !== 'Pod' ? 'Kết nối tới một pod đang ready (giống <code>kubectl port-forward</code>, không cân bằng tải).' : ''}</p>
      ${existing.length ? `<p>Đang mở: ${existing.map(f => `<a href="http://127.0.0.1:${f.localPort}" target="_blank" rel="noopener">127.0.0.1:${f.localPort}</a> → ${f.port}`).join(', ')}</p>` : ''}
    </div>
    <div class="m-foot"><button class="btn" data-close>Huỷ</button><button class="btn primary" id="pfStart">Mở port-forward</button></div>`,
    box => {
      box.addEventListener('click', async e => {
        if (e.target.closest('[data-close]')) { closeModal(false); return; }
        if (!e.target.closest('#pfStart')) return;
        const sel = box.querySelector('input[name=pfport]:checked')?.value;
        const port = sel && sel !== 'custom' ? +sel : +box.querySelector('#pfCustom').value;
        if (!port) { toast('Chọn hoặc nhập cổng đích', 'err'); return; }
        const btn = box.querySelector('#pfStart'); btn.disabled = true; btn.textContent = 'Đang mở…';
        try {
          const f = await pfApi('POST', '', { kind: n.kind, namespace: n.namespace, name: n.name, port, localPort: +box.querySelector('#pfLocal').value || 0 });
          closeModal(false);
          toast(`Đã mở 127.0.0.1:${f.localPort} → ${f.pod}:${f.targetPort}`);
          await refreshPf();
          pf.open = f.id; openPfList(); // show the remote-access options of the new forward
        } catch (x) { btn.disabled = false; btn.textContent = 'Mở port-forward'; toast(x.message, 'err'); }
      });
      box.addEventListener('focusin', e => { if (e.target.id === 'pfCustom') { const c = box.querySelector('input[value=custom]'); if (c) c.checked = true; } });
    });
}

function openPfList() {
  openModal(`
    <div class="m-head"><h3>Port-forward đang mở</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body" id="pfListBody">${pfListHtml()}</div>`,
    box => (box.classList.add('mid'), box).addEventListener('click', async e => {
      if (e.target.closest('[data-close]')) { closeModal(false); return; }
      const cp = e.target.closest('[data-copy-text]');
      if (cp) { navigator.clipboard?.writeText(cp.dataset.copyText).then(() => toast('Đã sao chép')); return; }
      const rt = e.target.closest('[data-pfremote]');
      if (rt) { pf.open = pf.open === rt.dataset.pfremote ? null : rt.dataset.pfremote; box.querySelector('#pfListBody').innerHTML = pfListHtml(); return; }
      const s = e.target.closest('[data-pfstop]');
      if (s) { try { await pfApi('DELETE', '/' + s.dataset.pfstop); await refreshPf(); box.querySelector('#pfListBody').innerHTML = pfListHtml(); } catch (x) { toast(x.message, 'err'); } }
    }));
}

function pfListHtml() {
  if (!pf.list.length) return '<p class="muted">Không có port-forward nào.</p>';
  return `<table class="tbl pf-tbl"><thead><tr><th>Local</th><th>Tới</th><th>Pod</th><th></th></tr></thead><tbody>${pf.list.map(f => `<tr>
    <td><a href="http://127.0.0.1:${f.localPort}" target="_blank" rel="noopener">127.0.0.1:${f.localPort}</a>${f.alive ? '' : ' <span class="bad">đã đóng</span>'}</td>
    <td>${esc(f.kind)} ${esc(f.namespace)}/${esc(f.name)}:${f.port}</td><td class="sub">${esc(f.pod)}:${f.targetPort}</td>
    <td class="pf-act">${pf.remote?.enabled && f.alive ? `<a class="btn sm" href="${esc(remoteBase())}/pf/${esc(f.id)}/${esc(f.token)}/" target="_blank" rel="noopener noreferrer" title="Mở qua proxy HTTP (dùng được từ máy khác)">Mở qua web</a>
      <button class="btn sm ${pf.open === f.id ? 'on' : ''}" data-pfremote="${esc(f.id)}" aria-expanded="${pf.open === f.id}">Kết nối từ xa</button>` : ''}
      <button class="btn sm" data-pfstop="${esc(f.id)}">Dừng</button></td></tr>
    ${f.error ? `<tr class="pf-err"><td colspan="4"><span class="pf-err-ic">!</span><div><b>Lần kết nối gần nhất bị lỗi</b><div>${esc(f.error)}</div></div></td></tr>` : ''}
    ${pf.open === f.id ? `<tr class="pf-remote"><td colspan="4">${remoteHtml(f)}</td></tr>` : ''}`).join('')}</tbody></table>`;
}

async function refreshPf() {
  try { pf.list = await pfApi('GET'); } catch { return; }
  const chip = $('pfChip');
  chip.hidden = !pf.list.length;
  chip.querySelector('b').textContent = pf.list.length;
  chip.classList.toggle('bad', pf.list.some(f => !f.alive));
  chip.classList.toggle('warn', pf.list.some(f => f.alive && f.error));
}

$('pfChip').onclick = openPfList;
$('detail').addEventListener('click', e => {
  if (!e.target.closest('[data-pf=open]') || !state.selected) return;
  const n = state.graph?.nodes.find(x => x.id === state.selected);
  if (n) openPortForward(n);
});
refreshPf();
setInterval(refreshPf, 5000);
