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

const ICON_EDIT = '<svg class="i" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const ICON_UP = '<svg class="i" viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const ICON_BACK = '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
const host = s => String(s || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const ctxHue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/* command-palette style picker: search on top, keyboard list, import as a second screen */
function clusterList(data, q) {
  const ql = q.trim().toLowerCase();
  const match = c => !ql || [c.context, c.server, c.namespace, c.fileLabel].some(x => (x || '').toLowerCase().includes(ql));
  const ctxs = data.contexts.filter(match);
  if (!data.contexts.length) return `<div class="clp-empty"><b>Chưa có cluster nào</b><span>Import một file kubeconfig để bắt đầu.</span></div>`;
  if (!ctxs.length) return `<div class="clp-empty"><span>Không có cluster nào khớp “${esc(q)}”</span></div>`;
  const ini = n => (String(n).replace(/[^a-z0-9]+/gi, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?').toUpperCase();
  const row = c => `<div class="clp-row ${c.current ? 'cur' : ''}" role="option" tabindex="-1" ${c.current ? 'aria-selected="true"' : ''}
      data-file="${esc(c.file)}" data-ctx="${esc(c.context)}" title="${esc(c.file)}">
      <span class="clp-ic" style="--h:${ctxHue(c.context)}">${esc(ini(c.context))}</span>
      <span class="clp-main">
        <span class="clp-name">${esc(c.context)}${c.current ? '<span class="clp-badge"><i></i>Đang dùng</span>' : ''}</span>
        <span class="clp-meta"><span class="clp-host">${esc(host(c.server))}</span>${c.namespace ? `<span>ns ${esc(c.namespace)}</span>` : ''}<span class="clp-file">${esc(c.managed ? c.fileLabel.replace(/\.ya?ml$/, '') : '~/.kube/config')}</span></span>
      </span>
      <span class="clp-act">${c.managed ? `<button data-ren="${esc(c.file)}" title="Đổi tên file">${ICON_EDIT}</button>` : ''}${c.managed && !c.current ? `<button data-del="${esc(c.file)}" title="Xoá file kubeconfig">${ICON_TRASH}</button>` : ''}</span>
      <span class="clp-end">${c.current ? '' : '<kbd>↵</kbd>'}</span>
    </div>`;
  const cur = ctxs.filter(c => c.current), rest = ctxs.filter(c => !c.current);
  return (cur.length ? `<div class="clp-sec">Đang dùng</div>${cur.map(row).join('')}` : '')
    + (rest.length ? `<div class="clp-sec">${cur.length ? 'Khác' : 'Cluster'}</div>${rest.map(row).join('')}` : '');
}

function clusterModalHtml(data) {
  return `<div class="clp" data-screen="list">
    <div class="clp-screen" data-pane="list">
      <div class="clp-search"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="clQ" type="text" placeholder="Chuyển cluster…" autocomplete="off" spellcheck="false" aria-label="Tìm cluster" data-autofocus>
        <kbd>Esc</kbd></div>
      <div class="clp-list" id="clList" role="listbox">${clusterList(data, '')}</div>
      <div class="clp-foot">
        <button class="clp-import" data-go="import">${ICON_UP}Import kubeconfig</button>
        <span class="clp-keys"><kbd>↑</kbd><kbd>↓</kbd> chọn <kbd>↵</kbd> kết nối</span>
      </div>
    </div>
    <div class="clp-screen" data-pane="import" hidden>
      <div class="clp-ih"><button class="clp-back" data-go="list" aria-label="Quay lại">${ICON_BACK}</button><b>Import kubeconfig</b></div>
      <div class="clp-ib">
        <label class="clp-drop" id="clDrop"><input type="file" id="clFile" hidden>
          ${ICON_UP}<b id="clDropT">Thả file kubeconfig vào đây</b><span id="clDropS">hoặc bấm để chọn · YAML, tối đa 1 MB</span></label>
        <div class="clp-or"><span>hoặc dán nội dung</span></div>
        <textarea id="clContent" rows="6" spellcheck="false" placeholder="apiVersion: v1&#10;kind: Config&#10;…"></textarea>
        <label class="clp-field">Tên hiển thị<input id="clName" placeholder="vd. production, gcp-k3s" autocomplete="off" spellcheck="false"></label>
        <p class="clp-note">Lưu trên máy chạy Kubemap (<code>${esc(data.dir)}</code>), không vào git. Chỉ import file bạn tin cậy.</p>
      </div>
      <div class="clp-foot"><span class="cl-err" id="clErr"></span><button class="btn" data-go="list">Huỷ</button><button class="btn primary" id="clImport">Import</button></div>
    </div>
  </div>`;
}

async function openClusterPicker() {
  let data;
  try { data = await clusterApi('GET'); } catch (e) { toast(e.message, 'err'); return; }
  openModal(clusterModalHtml(data), box => {
    box.classList.add('cl-modal');
    const $q = box.querySelector('#clQ'), $list = box.querySelector('#clList');
    let active = 0, content = '';
    const rows = () => [...$list.querySelectorAll('.clp-row')];
    const mark = (i, scroll = true) => {
      const r = rows(); if (!r.length) return;
      active = Math.max(0, Math.min(r.length - 1, i));
      r.forEach((x, k) => x.classList.toggle('on', k === active));
      if (scroll) r[active].scrollIntoView({ block: 'nearest' });
    };
    const refresh = d => { if (d) data = d; $list.innerHTML = clusterList(data, $q.value); const r = rows(); mark(Math.max(0, r.findIndex(x => !x.classList.contains('cur'))), false); };
    const err = msg => { box.querySelector('#clErr').textContent = msg || ''; };
    const screen = s => {
      box.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== s; });
      (s === 'list' ? $q : box.querySelector('#clContent')).focus();
    };
    const busy = on => box.querySelectorAll('button, input, textarea').forEach(b => { b.disabled = on; });

    async function doSwitch(row) {
      if (!row || row.classList.contains('cur')) return;
      busy(true);
      row.classList.add('loading');
      row.querySelector('.clp-end').innerHTML = '<span class="spinner"></span>';
      try {
        await clusterApi('POST', '/switch', { file: row.dataset.file, context: row.dataset.ctx });
        closeModal(false);
        toast('Đã chuyển sang ' + row.dataset.ctx);
        onClusterSwitched();
      } catch (e) {
        busy(false);
        refresh();
        toast(e.message, 'err');
      }
    }
    refresh();

    $q.addEventListener('input', () => refresh());
    box.addEventListener('keydown', e => {
      if (box.querySelector('[data-pane=list]').hidden || e.target.classList.contains('cl-ren')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mark(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); doSwitch(rows()[active]); }
    });
    $list.addEventListener('mousemove', e => { const r = e.target.closest('.clp-row'); if (r) mark(rows().indexOf(r), false); });

    box.addEventListener('click', async e => {
      const go = e.target.closest('[data-go]');
      if (go) { screen(go.dataset.go); return; }
      const ren = e.target.closest('button[data-ren]');
      if (ren) { // inline rename of the file this context lives in
        const row = ren.closest('.clp-row'), label = row.querySelector('.clp-file');
        const input = document.createElement('input');
        input.className = 'cl-ren'; input.value = label.textContent.split(' · ')[0]; input.spellcheck = false;
        label.replaceWith(input); input.focus(); input.select();
        row.classList.add('renaming');
        const done = async save => {
          if (input.dataset.done) return; input.dataset.done = '1';
          if (save && input.value.trim()) {
            try { refresh(await clusterApi('POST', '/rename', { file: ren.dataset.ren, name: input.value })); toast('Đã đổi tên'); $q.focus(); return; }
            catch (x) { toast(x.message, 'err'); }
          }
          refresh(); $q.focus();
        };
        input.addEventListener('keydown', k => { k.stopPropagation(); if (k.key === 'Enter') done(true); if (k.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
        input.addEventListener('click', k => k.stopPropagation());
        return;
      }
      const del = e.target.closest('button[data-del]');
      if (del) {
        if (del.dataset.armed !== '1') { // second click confirms
          del.dataset.armed = '1'; del.classList.add('armed'); del.title = 'Bấm lần nữa để xoá';
          setTimeout(() => { del.dataset.armed = ''; del.classList.remove('armed'); }, 3000);
          return;
        }
        try { refresh(await clusterApi('DELETE', '?file=' + encodeURIComponent(del.dataset.del))); toast('Đã xoá kubeconfig'); }
        catch (x) { toast(x.message, 'err'); }
        return;
      }
      const row = e.target.closest('.clp-row');
      if (row) doSwitch(row);
    });

    const drop = box.querySelector('#clDrop');
    const setFile = async f => {
      if (!f) return;
      if (f.size > 1024 * 1024) { err('File quá lớn (> 1 MB)'); return; }
      content = await f.text();
      box.querySelector('#clContent').value = content;
      drop.classList.add('has');
      box.querySelector('#clDropT').textContent = f.name;
      box.querySelector('#clDropS').textContent = `${(f.size / 1024).toFixed(1)} KB · bấm để đổi file`;
      const name = box.querySelector('#clName');
      if (!name.value) name.value = f.name.replace(/\.(ya?ml|conf|config|kubeconfig)$/i, '');
      err('');
    };
    box.querySelector('#clFile').addEventListener('change', e => setFile(e.target.files[0]));
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => setFile(e.dataTransfer.files[0]));

    box.querySelector('#clImport').addEventListener('click', async () => {
      const yaml = box.querySelector('#clContent').value || content;
      if (!yaml.trim()) { err('Chọn file hoặc dán nội dung kubeconfig'); return; }
      err(''); busy(true);
      try {
        const d = await clusterApi('POST', '/import', { name: box.querySelector('#clName').value, content: yaml });
        busy(false);
        $q.value = ''; screen('list'); refresh(d);
        const added = d.contexts.filter(c => c.file === d.imported);
        if (added.length === 1) doSwitch($list.querySelector(`.clp-row[data-file="${CSS.escape(added[0].file)}"]`));
        else toast(`Đã import ${added.length} context — chọn một để kết nối`);
      } catch (e) { busy(false); err(e.message); }
    });
  });
}

/* new cluster: forget everything tied to the old one and resubscribe */
function onClusterSwitched() {
  if (state.nsMulti) { // the ticked namespaces belong to the old cluster: show everything
    state.nsMulti = null; store.set('ns', '*');
    const u = new URL(location); u.searchParams.set('ns', '*'); history.replaceState(null, '', u);
  } else if ($('ns').value !== '*') {
    $('ns').innerHTML = '<option value="default">default</option>';
    $('ns').value = 'default';
    store.set('ns', 'default');
    const u = new URL(location); u.searchParams.set('ns', 'default'); history.replaceState(null, '', u);
  }
  state.structureKey = ''; state.manual.clear(); clearDetail(); connect();
}

$('ctx').addEventListener('click', openClusterPicker);
