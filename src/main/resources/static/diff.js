'use strict';
/*
 * Side-by-side YAML compare: two objects of the same kind (YAML tab → "So sánh…"), or two revisions of a Helm
 * release (Helm → Lịch sử). Line diff by LCS after trimming the common head/tail; long unchanged runs fold.
 * Depends on app.js ($, esc, state) and actions.js (openModal, closeModal, toast).
 */

/** [{t:'same'|'del'|'add', a, b}] — a/b are line indexes in the left/right text */
function lineDiff(A, B) {
  let s = 0, ea = A.length, eb = B.length;
  while (s < ea && s < eb && A[s] === B[s]) s++;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s, out = [];
  for (let i = 0; i < s; i++) out.push({ t: 'same', a: i, b: i });
  if (n * m > 4e6) { // too big for LCS: everything in the middle counts as changed
    for (let i = 0; i < n; i++) out.push({ t: 'del', a: s + i });
    for (let j = 0; j < m; j++) out.push({ t: 'add', b: s + j });
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[s + i] === B[s + j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[s + i] === B[s + j]) { out.push({ t: 'same', a: s + i, b: s + j }); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { out.push({ t: 'add', b: s + j }); j++; }
      else { out.push({ t: 'del', a: s + i }); i++; }
    }
  }
  for (let k = 0; k < A.length - ea; k++) out.push({ t: 'same', a: ea + k, b: eb + k });
  return out;
}

/* pair each run of deletions with the following additions so changed lines sit side by side */
function diffRows(ops) {
  const rows = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].t === 'same') { rows.push({ t: 'same', a: ops[k].a, b: ops[k].b }); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].t !== 'same') { (ops[k].t === 'del' ? dels : adds).push(ops[k]); k++; }
    for (let x = 0; x < Math.max(dels.length, adds.length); x++)
      rows.push({ t: dels[x] && adds[x] ? 'chg' : dels[x] ? 'del' : 'add', a: dels[x]?.a, b: adds[x]?.b });
  }
  return rows;
}

function renderDiff(box, left, right) {
  const A = left.replace(/\n$/, '').split('\n'), B = right.replace(/\n$/, '').split('\n');
  const rows = diffRows(lineDiff(A, B));
  const plus = rows.filter(r => r.b != null && r.t !== 'same').length, minus = rows.filter(r => r.a != null && r.t !== 'same').length;
  box.querySelector('.df-sum').innerHTML = plus || minus ? `<b class="add">+${plus}</b> <b class="del">−${minus}</b> dòng` : '<b>Giống hệt nhau</b>';
  const CONTEXT = 3, html = [];
  for (let k = 0; k < rows.length;) {
    if (rows[k].t === 'same') {
      let e = k; while (e < rows.length && rows[e].t === 'same') e++;
      const run = e - k, keepHead = k === 0 ? 0 : CONTEXT, keepTail = e === rows.length ? 0 : CONTEXT;
      if (run > keepHead + keepTail + 2) {
        for (let x = k; x < k + keepHead; x++) html.push(rowHtml(rows[x], A, B));
        html.push(`<tr class="fold" data-from="${k + keepHead}" data-to="${e - keepTail}"><td colspan="4">⋯ ${run - keepHead - keepTail} dòng giống nhau (bấm để mở)</td></tr>`);
        for (let x = e - keepTail; x < e; x++) html.push(rowHtml(rows[x], A, B));
      } else for (let x = k; x < e; x++) html.push(rowHtml(rows[x], A, B));
      k = e;
    } else { html.push(rowHtml(rows[k], A, B)); k++; }
  }
  const tbl = box.querySelector('.df-table');
  tbl.innerHTML = `<colgroup><col class="ln"><col><col class="ln"><col></colgroup><tbody>${html.join('')}</tbody>`;
  tbl.onclick = e => {
    const f = e.target.closest('tr.fold'); if (!f) return;
    f.outerHTML = rows.slice(+f.dataset.from, +f.dataset.to).map(r => rowHtml(r, A, B)).join('');
  };
}

function rowHtml(r, A, B) {
  const l = r.a != null ? esc(A[r.a]) : '', rt = r.b != null ? esc(B[r.b]) : '';
  const lc = r.t === 'same' ? '' : r.a != null ? 'del' : 'empty', rc = r.t === 'same' ? '' : r.b != null ? 'add' : 'empty';
  return `<tr><td class="ln">${r.a != null ? r.a + 1 : ''}</td><td class="${lc}">${l}</td><td class="ln">${r.b != null ? r.b + 1 : ''}</td><td class="${rc}">${rt}</td></tr>`;
}

/**
 * sides: [{ choices: [{value, label}], value }, { … }]; load(value, toggles) → Promise<text>;
 * toggles: [{id, label, on}] re-load both sides when changed.
 */
function openDiff({ title, sides, load, toggles = [], note = '' }) {
  const sel = (i, s) => `<select data-side="${i}" aria-label="${i ? 'Bên phải' : 'Bên trái'}">${s.choices.map(c => `<option value="${esc(c.value)}" ${c.value === s.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
  openModal(`
    <div class="m-head"><h3>${esc(title)}</h3><button class="icon-btn sm" data-close aria-label="Đóng"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="df-bar">
      <div class="df-side">${sel(0, sides[0])}</div><div class="df-side">${sel(1, sides[1])}</div>
    </div>
    <div class="df-opts">${toggles.map(t => `<label><input type="checkbox" data-tg="${t.id}" ${t.on ? 'checked' : ''}> ${esc(t.label)}</label>`).join('')}
      ${note ? `<span class="muted">${esc(note)}</span>` : ''}<span class="df-sum"></span></div>
    <div class="df-wrap"><table class="df-table"><tbody><tr><td class="df-loading">Đang tải…</td></tr></tbody></table></div>`,
    async box => {
      const opts = () => Object.fromEntries(toggles.map(t => [t.id, box.querySelector(`[data-tg="${t.id}"]`).checked]));
      let seq = 0;
      const refresh = async () => {
        const my = ++seq, o = opts();
        const vals = [0, 1].map(i => box.querySelector(`[data-side="${i}"]`).value);
        try {
          const [l, r] = await Promise.all(vals.map(v => load(v, o)));
          if (my === seq) renderDiff(box, l, r);
        } catch (e) { if (my === seq) box.querySelector('.df-table').innerHTML = `<tbody><tr><td class="df-loading">Không tải được: ${esc(e.message)}</td></tr></tbody>`; }
      };
      box.addEventListener('change', e => { if (e.target.matches('[data-side], [data-tg]')) refresh(); });
      box.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(false); });
      refresh();
    }, { wide: true });
}

/* YAML tab → compare this object with another object of the same kind */
function compareObject(n) {
  const same = (state.graph?.nodes || []).filter(x => x.kind === n.kind && !x.missing && (x.group || null) === (n.group || null));
  const label = x => (x.namespace ? x.namespace + '/' : '') + x.name;
  const choices = same.map(x => ({ value: x.id, label: label(x) })).sort((a, b) => a.label.localeCompare(b.label));
  if (choices.length < 2) { toast(`Không có ${n.kind} nào khác trong view hiện tại để so sánh`, 'err'); return; }
  // default partner: same name in another namespace (staging vs prod), else the next one
  const partner = same.find(x => x.id !== n.id && x.name === n.name) || same.find(x => x.id !== n.id);
  const byId = new Map(same.map(x => [x.id, x]));
  openDiff({
    title: `So sánh ${n.kind}`,
    sides: [{ choices, value: n.id }, { choices, value: partner.id }],
    toggles: [{ id: 'clean', label: 'Bỏ trường hệ thống (uid, resourceVersion, timestamps…)', on: true }, { id: 'status', label: 'Gồm status', on: false }],
    load: async (id, o) => {
      const x = byId.get(id);
      const r = await fetch('/api/actions/manifest?' + new URLSearchParams({ kind: x.kind, namespace: x.namespace || '', name: x.name, clean: o.clean, status: o.status }));
      const m = await r.json();
      if (!r.ok) throw new Error(m.error || r.statusText);
      return m.yaml;
    },
  });
}

/* Helm → compare two revisions' manifests (or values) */
function compareHelmRevisions(ns, name, history) {
  const choices = history.map(h => ({ value: String(h.revision), label: `rev ${h.revision} · ${h.status}${h.description ? ' · ' + h.description : ''}` }));
  if (choices.length < 2) { toast('Release mới có một revision', 'err'); return; }
  openDiff({
    title: `So sánh revision · ${name}`,
    sides: [{ choices, value: choices[1].value }, { choices, value: choices[0].value }],
    toggles: [{ id: 'values', label: 'So values người dùng thay vì manifest', on: false }],
    note: 'Giá trị Secret trong manifest đã được ẩn.',
    load: async (rev, o) => {
      const q = new URLSearchParams({ namespace: ns, name, revision: rev });
      const r = await fetch((o.values ? '/api/helm/values?' : '/api/helm/manifest?') + q);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d.yaml;
    },
  });
}
