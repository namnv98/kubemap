'use strict';
/*
 * Port-forward: "Port-forward" in the panel toolbar (Pod, Service, workloads) → pick a port → 127.0.0.1:<local>.
 * The top-bar chip lists active forwards (open / stop). Depends on app.js ($, esc, state) and actions.js (openModal, closeModal, toast).
 */
const PF_KINDS = ['Pod', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'];
const pf = { list: [] };

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
      <p class="muted">Chỉ mở trên 127.0.0.1. ${n.kind === 'Service' || n.kind !== 'Pod' ? 'Kết nối tới một pod đang ready (giống <code>kubectl port-forward</code>, không cân bằng tải).' : ''}</p>
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
          refreshPf();
        } catch (x) { btn.disabled = false; btn.textContent = 'Mở port-forward'; toast(x.message, 'err'); }
      });
      box.addEventListener('focusin', e => { if (e.target.id === 'pfCustom') { const c = box.querySelector('input[value=custom]'); if (c) c.checked = true; } });
    });
}

function openPfList() {
  openModal(`
    <div class="m-head"><h3>Port-forward đang mở</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body" id="pfListBody">${pfListHtml()}</div>`,
    box => box.addEventListener('click', async e => {
      if (e.target.closest('[data-close]')) { closeModal(false); return; }
      const s = e.target.closest('[data-pfstop]');
      if (s) { try { await pfApi('DELETE', '/' + s.dataset.pfstop); await refreshPf(); box.querySelector('#pfListBody').innerHTML = pfListHtml(); } catch (x) { toast(x.message, 'err'); } }
    }));
}

function pfListHtml() {
  if (!pf.list.length) return '<p class="muted">Không có port-forward nào.</p>';
  return `<table class="tbl"><thead><tr><th>Local</th><th>Tới</th><th>Pod</th><th></th></tr></thead><tbody>${pf.list.map(f => `<tr>
    <td><a href="http://127.0.0.1:${f.localPort}" target="_blank" rel="noopener">127.0.0.1:${f.localPort}</a>${f.alive && !f.error ? '' : ` <span class="bad">${esc(f.error || 'đã đóng')}</span>`}</td>
    <td>${esc(f.kind)} ${esc(f.namespace)}/${esc(f.name)}:${f.port}</td><td class="sub">${esc(f.pod)}:${f.targetPort}</td>
    <td><button class="btn sm" data-pfstop="${esc(f.id)}">Dừng</button></td></tr>`).join('')}</tbody></table>`;
}

async function refreshPf() {
  try { pf.list = await pfApi('GET'); } catch { return; }
  const chip = $('pfChip');
  chip.hidden = !pf.list.length;
  chip.querySelector('b').textContent = pf.list.length;
  chip.classList.toggle('bad', pf.list.some(f => !f.alive || f.error));
}

$('pfChip').onclick = openPfList;
$('detail').addEventListener('click', e => {
  if (!e.target.closest('[data-pf=open]') || !state.selected) return;
  const n = state.graph?.nodes.find(x => x.id === state.selected);
  if (n) openPortForward(n);
});
refreshPf();
setInterval(refreshPf, 5000);
