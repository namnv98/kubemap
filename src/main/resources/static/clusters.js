'use strict';
/*
 * Cluster picker: click the cluster chip in the top bar to list kube contexts, import a kubeconfig
 * (paste or choose a file) and switch cluster without restarting the app.
 * Depends on app.js (state, $, esc, store, clearDetail, connect) and actions.js (openModal, closeModal, toast).
 */
async function clusterApi(method, path = '', body) {
  const r = await fetch('/api/clusters' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-K8s-Studio': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

const ICON_X = '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_TRASH = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

function clusterRows(data) {
  if (!data.contexts.length) return `<p class="cl-empty">Chưa có kubeconfig nào. Hãy import một file ở bên dưới.</p>`;
  const byFile = new Map();
  for (const c of data.contexts) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  return [...byFile.values()].map(list => {
    const f = list[0];
    const inUse = list.some(c => c.current);
    return `<div class="cl-file">
      <div class="cl-file-head">
        <span class="cl-tag ${f.managed ? 'imp' : ''}">${f.managed ? 'Đã import' : 'Máy này'}</span>
        <code title="${esc(f.file)}">${esc(f.fileLabel)}</code>
        ${f.managed && !inUse ? `<button class="icon-btn sm cl-del" data-del="${esc(f.file)}" title="Xoá kubeconfig này" aria-label="Xoá ${esc(f.fileLabel)}">${ICON_TRASH}</button>` : ''}
      </div>
      ${list.map(c => `<div class="cl-row ${c.current ? 'cur' : ''}">
        <div class="cl-main"><b>${esc(c.context)}</b><span>${esc(c.server || '?')}${c.namespace ? ` · ns ${esc(c.namespace)}` : ''}</span></div>
        ${c.current ? '<span class="cl-cur">Đang dùng</span>'
          : `<button class="btn sm" data-file="${esc(c.file)}" data-ctx="${esc(c.context)}">Kết nối</button>`}
      </div>`).join('')}
    </div>`;
  }).join('');
}

function clusterModalHtml(data) {
  return `
    <div class="m-head"><h3>Cluster</h3><button class="icon-btn sm" data-close aria-label="Đóng">${ICON_X}</button></div>
    <div class="m-body cl">
      <div class="cl-list" id="clList">${clusterRows(data)}</div>
      <div class="cl-import">
        <h4>Import kubeconfig</h4>
        <div class="cl-irow">
          <input id="clName" placeholder="Tên (vd. gcp-k3s)" autocomplete="off" spellcheck="false">
          <label class="btn sm"><input type="file" id="clFile" hidden>Chọn file…</label>
        </div>
        <textarea id="clContent" rows="7" spellcheck="false" placeholder="…hoặc dán nội dung kubeconfig (YAML) vào đây"></textarea>
        <p class="cl-note">File được lưu trong <code>${esc(data.dir)}</code> trên máy chạy K8s Studio (không đưa vào git). Kubeconfig chứa quyền truy cập cluster, chỉ import file bạn tin cậy.</p>
        <div class="cl-ifoot"><span class="cl-err" id="clErr"></span><button class="btn primary" id="clImport">Import</button></div>
      </div>
    </div>`;
}

async function openClusterPicker() {
  let data;
  try { data = await clusterApi('GET'); } catch (e) { toast(e.message, 'err'); return; }
  openModal(clusterModalHtml(data), box => {
    const err = msg => { box.querySelector('#clErr').textContent = msg || ''; };
    const refresh = d => { data = d; box.querySelector('#clList').innerHTML = clusterRows(d); };
    const busy = on => box.querySelectorAll('button, input, textarea').forEach(b => { if (!b.hasAttribute('data-close')) b.disabled = on; });

    async function doSwitch(file, ctx, btn) {
      busy(true);
      if (btn) btn.textContent = 'Đang kết nối…';
      try {
        await clusterApi('POST', '/switch', { file, context: ctx });
        closeModal(false);
        toast('Đã chuyển sang cluster ' + ctx);
        onClusterSwitched();
      } catch (e) {
        busy(false);
        if (btn) btn.textContent = 'Kết nối';
        toast(e.message, 'err');
      }
    }

    box.addEventListener('click', async e => {
      if (e.target.closest('[data-close]')) { closeModal(false); return; }
      const sw = e.target.closest('button[data-ctx]');
      if (sw) { doSwitch(sw.dataset.file, sw.dataset.ctx, sw); return; }
      const del = e.target.closest('button[data-del]');
      if (del) {
        if (del.dataset.armed !== '1') { // second click confirms (no browser confirm dialog)
          del.dataset.armed = '1'; del.classList.add('armed'); del.title = 'Bấm lần nữa để xoá';
          setTimeout(() => { del.dataset.armed = ''; del.classList.remove('armed'); }, 3000);
          return;
        }
        try { refresh(await clusterApi('DELETE', '?file=' + encodeURIComponent(del.dataset.del))); toast('Đã xoá kubeconfig'); }
        catch (x) { toast(x.message, 'err'); }
      }
    });

    box.querySelector('#clFile').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 1024 * 1024) { err('File quá lớn (> 1MB), có chắc là kubeconfig?'); return; }
      box.querySelector('#clContent').value = await f.text();
      const name = box.querySelector('#clName');
      if (!name.value) name.value = f.name.replace(/\.(ya?ml|conf|config|kubeconfig)$/i, '');
      err('');
    });

    box.querySelector('#clImport').addEventListener('click', async () => {
      const content = box.querySelector('#clContent').value;
      if (!content.trim()) { err('Hãy chọn file hoặc dán nội dung kubeconfig'); return; }
      err('');
      busy(true);
      try {
        const d = await clusterApi('POST', '/import', { name: box.querySelector('#clName').value, content });
        refresh(d);
        busy(false);
        box.querySelector('#clContent').value = ''; box.querySelector('#clName').value = ''; box.querySelector('#clFile').value = '';
        const added = d.contexts.filter(c => c.file === d.imported);
        if (added.length === 1) { doSwitch(added[0].file, added[0].context, box.querySelector(`button[data-ctx][data-file="${CSS.escape(added[0].file)}"]`)); }
        else toast(`Đã import ${added.length} context, chọn một context để kết nối`);
      } catch (e) {
        busy(false);
        err(e.message);
      }
    });
  });
}

/* new cluster: forget everything tied to the old one and resubscribe */
function onClusterSwitched() {
  if ($('ns').value !== '*') {
    $('ns').innerHTML = '<option value="default">default</option>';
    $('ns').value = 'default';
    store.set('ns', 'default');
    const u = new URL(location); u.searchParams.set('ns', 'default'); history.replaceState(null, '', u);
  }
  state.structureKey = ''; state.manual.clear(); clearDetail(); connect();
}

$('ctx').addEventListener('click', openClusterPicker);
