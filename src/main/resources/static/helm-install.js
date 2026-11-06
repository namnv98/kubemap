'use strict';
/*
 * Helm repositories and chart install (helm CLI on the server; write-guarded, audited).
 * "Repo" lists / adds / updates / removes repos; "Cài chart" searches, loads the chart's default values into an editor,
 * then dry-runs (server-side) or installs. Depends on helm.js (hm, loadHelm), actions.js (api, openModal, closeModal, toast).
 */
function helmToolbar() {
  const bar = $('helm').querySelector('.tl-bar');
  if (bar.querySelector('#hmRepos')) return;
  const close = bar.querySelector('#hmClose');
  close.insertAdjacentHTML('beforebegin', `<button class="btn sm" id="hmRepos">Repo</button><button class="btn sm primary" id="hmInstall">Cài chart…</button>`);
}

async function openRepos() {
  const html = list => `
    <div class="m-head"><h3>Helm repository</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="m-body">
      ${list.length ? `<table class="tbl"><thead><tr><th>Tên</th><th>URL</th><th></th></tr></thead><tbody>${list.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="sub">${esc(r.url)}</td>
        <td><button class="btn sm danger-outline" data-rmrepo="${esc(r.name)}">Xoá</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">Chưa có repo nào.</p>'}
      <div class="hr-add"><input id="repoName" placeholder="tên (vd. bitnami)" autocomplete="off"><input id="repoUrl" placeholder="https://charts.example.com hoặc oci://…" autocomplete="off">
        <button class="btn sm primary" id="repoAdd">Thêm</button></div>
      <p class="muted small">Dùng chung cấu hình repo với lệnh <code>helm</code> trên máy chạy Kubemap.</p>
    </div>
    <div class="m-foot"><button class="btn" id="repoUpdate">Cập nhật index (helm repo update)</button><button class="btn" data-close>Đóng</button></div>`;
  let list = [];
  try { list = await api('GET', 'helm/repos'); } catch (e) { toast(e.message, 'err'); return; }
  openModal(html(list), box => box.addEventListener('click', async e => {
    if (e.target.closest('[data-close]')) { closeModal(false); return; }
    const busy = async (btn, fn) => { btn.disabled = true; try { const r = await fn(); toast(r.message); box.innerHTML = html(await api('GET', 'helm/repos')); } catch (x) { toast(x.message, 'err'); btn.disabled = false; } };
    const rm = e.target.closest('[data-rmrepo]');
    if (rm) busy(rm, () => api('POST', 'helm/repo/remove', { name: rm.dataset.rmrepo }));
    if (e.target.closest('#repoAdd')) busy(e.target.closest('#repoAdd'), () => api('POST', 'helm/repo/add', { name: box.querySelector('#repoName').value.trim(), url: box.querySelector('#repoUrl').value.trim() }));
    if (e.target.closest('#repoUpdate')) busy(e.target.closest('#repoUpdate'), () => api('POST', 'helm/repo/update'));
  }));
}

function openInstall() {
  let editor = null, chosen = null;
  const nsOpts = [...$('ns').options].map(o => o.value).filter(v => v !== '*');
  openModal(`
    <div class="m-head"><h3>Cài Helm chart</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    ${typeof contextBar === 'function' ? contextBar() : ''}
    <div class="m-body hi">
      <div class="hi-search"><input id="hiQ" placeholder="Tìm chart trong các repo (vd. redis, nginx)…" autocomplete="off"><button class="btn sm" id="hiGo">Tìm</button></div>
      <div class="hi-results" id="hiRes"><p class="muted">Gõ từ khoá rồi bấm Tìm. Chưa có repo? Thêm ở nút <b>Repo</b>.</p></div>
      <div class="hi-form" id="hiForm" hidden>
        <div class="hi-row"><label>Chart <input id="hiChart" readonly></label><label>Version <input id="hiVer" placeholder="mới nhất"></label></div>
        <div class="hi-row"><label>Tên release <input id="hiName" autocomplete="off"></label>
          <label>Namespace <input id="hiNs" list="hiNsList" value="${esc(isAll() ? 'default' : currentNs())}" autocomplete="off"><datalist id="hiNsList">${nsOpts.map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
          <label class="ck"><input type="checkbox" id="hiCreate" checked> Tạo namespace nếu chưa có</label></div>
        <div class="hi-vh"><b>Values</b><span class="muted">mặc định của chart — sửa những gì cần, có thể xoá phần không đổi</span></div>
        <div class="hi-values" id="hiValues"></div>
        <pre class="hm-pre hi-out" id="hiOut" hidden></pre>
      </div>
    </div>
    <div class="m-foot"><button class="btn" data-close>Huỷ</button><button class="btn" id="hiDry" disabled>Kiểm tra (dry-run)</button><button class="btn primary" id="hiDo" disabled>Cài</button></div>`,
    box => {
      const search = async () => {
        const q = box.querySelector('#hiQ').value.trim();
        box.querySelector('#hiRes').innerHTML = '<p class="muted">Đang tìm…</p>';
        try {
          const list = await api('GET', 'helm/search?q=' + encodeURIComponent(q));
          box.querySelector('#hiRes').innerHTML = list.length ? list.slice(0, 50).map(c => `<button class="hi-item" data-chart="${esc(c.name)}" data-ver="${esc(c.version)}">
            <b>${esc(c.name)}</b><span>${esc(c.version)}${c.app_version ? ' · app ' + esc(c.app_version) : ''}</span><small>${esc(c.description || '')}</small></button>`).join('')
            : '<p class="muted">Không thấy chart nào.</p>';
        } catch (e) { box.querySelector('#hiRes').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
      };
      const run = async dry => {
        const body = { chart: chosen, version: box.querySelector('#hiVer').value.trim(), name: box.querySelector('#hiName').value.trim(),
          namespace: box.querySelector('#hiNs').value.trim(), createNamespace: box.querySelector('#hiCreate').checked, values: editor ? editor.getValue() : '', dryRun: dry };
        if (!body.name || !body.namespace) { toast('Cần tên release và namespace', 'err'); return; }
        const btn = box.querySelector(dry ? '#hiDry' : '#hiDo'); btn.disabled = true; const label = btn.textContent; btn.textContent = dry ? 'Đang kiểm tra…' : 'Đang cài…';
        const out = box.querySelector('#hiOut');
        try {
          const r = await api('POST', 'helm/install', body);
          if (dry) { out.hidden = false; out.textContent = r.output; toast(r.message); }
          else { closeModal(false); toast(r.message); hm.sel = body.namespace + '/' + body.name; loadHelm(); }
        } catch (e) { out.hidden = false; out.textContent = e.message; toast(dry ? 'Dry-run lỗi' : 'Cài lỗi', 'err'); }
        btn.disabled = false; btn.textContent = label;
      };
      box.addEventListener('click', async e => {
        if (e.target.closest('[data-close]')) { closeModal(false); return; }
        if (e.target.closest('#hiGo')) { search(); return; }
        if (e.target.closest('#hiDry')) { run(true); return; }
        if (e.target.closest('#hiDo')) { run(false); return; }
        const it = e.target.closest('.hi-item');
        if (it) {
          box.querySelectorAll('.hi-item').forEach(x => x.classList.toggle('on', x === it));
          chosen = it.dataset.chart;
          box.querySelector('#hiForm').hidden = false;
          box.querySelector('#hiChart').value = chosen;
          box.querySelector('#hiVer').value = it.dataset.ver;
          if (!box.querySelector('#hiName').value) box.querySelector('#hiName').value = chosen.split('/').pop();
          box.querySelector('#hiValues').innerHTML = '<p class="muted">Đang tải values…</p>';
          try {
            const v = await api('GET', 'helm/chart/values?' + new URLSearchParams({ chart: chosen, version: it.dataset.ver }));
            box.querySelector('#hiValues').innerHTML = '';
            editor = CodeMirror(box.querySelector('#hiValues'), { value: v.yaml, mode: 'yaml', lineNumbers: true, tabSize: 2, indentWithTabs: false });
            setTimeout(() => editor.refresh(), 30);
          } catch (x) { box.querySelector('#hiValues').innerHTML = `<p class="bad">${esc(x.message)}</p>`; editor = null; }
          box.querySelector('#hiDry').disabled = box.querySelector('#hiDo').disabled = false;
        }
      });
      box.querySelector('#hiQ').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    }, { wide: true, guard: () => true });
}

$('helm').addEventListener('click', e => {
  if (e.target.closest('#hmRepos')) openRepos();
  if (e.target.closest('#hmInstall')) openInstall();
});
/* helm.js calls helmToolbar() once it knows writes are on and the helm CLI is there */
if (hm.canWrite) helmToolbar();
