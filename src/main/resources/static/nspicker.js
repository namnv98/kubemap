'use strict';
/*
 * Namespace picker: a button + popover over the hidden <select id="ns">, which stays the source of truth for the server
 * query (everything reads $('ns').value / currentNs() and listens to its "change").
 * Tick one or more namespaces; none ticked = all. One ticked → the server is asked for just that namespace; several →
 * the server sends everything ("*") and state.nsMulti narrows it on this side (nsFilterGraph / nsKeep in app.js).
 * Each row shows its resource count and errors (known once an all-namespaces graph has arrived). Hover a row for
 * "Chỉ" = only this one.
 * Depends on app.js: $, esc, state, store, isSystemNs, nsParam.
 */
const nsp = { open: false, q: '', at: 0, items: [], stats: new Map() };
const NS_ALL = '*';

function nsRecent() { try { return JSON.parse(store.get('ns.recent') || '[]'); } catch { return []; } }
function nsRemember(list) {
  const add = list.filter(n => n !== NS_ALL);
  if (add.length) store.set('ns.recent', JSON.stringify([...add, ...nsRecent().filter(x => !add.includes(x))].slice(0, 4)));
}

/* the ticked namespaces; empty = all */
function nsSelected() {
  if (state.nsMulti) return new Set(state.nsMulti);
  const v = $('ns').value;
  return v && v !== NS_ALL ? new Set([v]) : new Set();
}

/* per-namespace totals and worst health, from a graph that holds every namespace (called by app.js on each push) */
function nsCollectStats(raw) {
  if (currentNs() !== NS_ALL || !raw) return;
  const m = new Map();
  for (const n of raw.nodes || []) {
    if (!n.namespace) continue;
    const s = m.get(n.namespace) || m.set(n.namespace, { total: 0, err: 0, warn: 0 }).get(n.namespace);
    s.total++;
    if (n.health === 'error') s.err++; else if (n.health === 'warn') s.warn++;
  }
  nsp.stats = m;
  if (nsp.open) nsRender();
}

function nsLabel() {
  const sel = [...nsSelected()];
  $('nsCur').textContent = !sel.length ? 'Tất cả namespace' : sel.length === 1 ? sel[0] : sel.slice(0, 2).join(', ');
  $('nsMore').textContent = sel.length > 2 ? '+' + (sel.length - 2) : '';
  $('nsMore').hidden = sel.length <= 2;
  $('nsBtn').title = !sel.length ? 'Namespace: tất cả' : 'Namespace: ' + sel.join(', ');
}

function nsRender() {
  const sel = nsSelected(), q = nsp.q.toLowerCase();
  const names = [...$('ns').options].map(o => o.value).filter(v => v !== NS_ALL);
  // ticked ones that the cluster no longer lists still show, so they can be unticked
  sel.forEach(n => { if (!names.includes(n)) names.push(n); });
  const hit = n => !q || n.toLowerCase().includes(q);
  const recent = q ? [] : nsRecent().filter(n => names.includes(n) && !sel.has(n)).slice(0, 3);
  const apps = names.filter(n => hit(n) && !isSystemNs(n)), sys = names.filter(n => hit(n) && isSystemNs(n));
  nsp.items = [];
  const box = on => `<span class="nsp-cb ${on ? 'on' : ''}">${on ? '<svg class="i" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>' : ''}</span>`;
  const row = (v, label) => {
    const i = nsp.items.push(v) - 1, s = nsp.stats.get(v), on = v === NS_ALL ? !sel.size : sel.has(v);
    const meta = v === NS_ALL ? `<small>${names.length}</small>`
      : s ? `${s.err ? `<span class="nsp-bad" title="${s.err} tài nguyên lỗi"><i></i>${s.err}</span>` : s.warn ? `<span class="nsp-warn" title="${s.warn} cảnh báo"><i></i>${s.warn}</span>` : ''}<small title="${s.total} tài nguyên">${s.total}</small>` : '';
    return `<div class="nsp-row ${on ? 'cur' : ''} ${i === nsp.at ? 'at' : ''}" role="option" aria-selected="${on}" data-nsv="${esc(v)}" data-i="${i}">
      ${box(on)}<span class="nsp-n">${label}</span>
      ${v === NS_ALL ? '' : `<button class="nsp-only" data-only="${esc(v)}" tabindex="-1" title="Chỉ xem ${esc(v)}">Chỉ</button>`}
      <span class="nsp-m">${meta}</span></div>`;
  };
  const mark = n => { if (!q) return esc(n); const i = n.toLowerCase().indexOf(q); return esc(n.slice(0, i)) + '<mark>' + esc(n.slice(i, i + q.length)) + '</mark>' + esc(n.slice(i + q.length)); };
  const sect = (t, list) => (list.length ? `<div class="nsp-h">${t}<span>${list.length}</span></div>` + list.map(n => row(n, mark(n))).join('') : '');
  let html = '';
  if (!q || 'tất cả namespace all'.includes(q)) html += row(NS_ALL, 'Tất cả namespace');
  html += sect('Gần đây', recent) + sect('Ứng dụng', apps) + sect('Hệ thống', sys);
  if (!nsp.items.length) html = `<div class="nsp-empty">Không có namespace nào khớp “${esc(nsp.q)}”</div>`;
  nsp.at = Math.min(nsp.at, Math.max(0, nsp.items.length - 1));
  $('nsList').innerHTML = html;
  $('nsList').querySelector('.nsp-row.at')?.scrollIntoView({ block: 'nearest' });
  const n = sel.size;
  $('nsSel').textContent = n ? `Đã chọn ${n} namespace` : 'Đang xem tất cả';
  $('nsClear').hidden = !n;
}

function nsOpen(on) {
  nsp.open = on;
  $('nsPop').hidden = !on;
  $('nsBtn').setAttribute('aria-expanded', String(on));
  if (!on) return;
  nsp.q = ''; $('nsQ').value = ''; nsp.at = 0;
  nsRender();
  $('nsQ').focus();
}

/* apply a set of namespaces (empty = all) */
function nsApply(set) {
  const list = [...set];
  const value = list.length === 1 ? list[0] : NS_ALL, multi = list.length > 1 ? new Set(list) : null;
  const same = value === $('ns').value && String(multi && [...multi].sort()) === String(state.nsMulti && [...state.nsMulti].sort());
  if (same) return;
  nsRemember(list);
  state.nsMulti = multi;
  if (value !== NS_ALL && ![...$('ns').options].some(o => o.value === value)) $('ns').add(new Option(value, value));
  $('ns').value = value;
  state.nsPicking = true;
  try { $('ns').dispatchEvent(new Event('change')); } finally { state.nsPicking = false; }
  nsLabel();
  if (nsp.open) nsRender();
}

function nsToggle(v) {
  if (v === NS_ALL) return nsApply(new Set());
  const s = nsSelected();
  s.has(v) ? s.delete(v) : s.add(v);
  nsApply(s);
}

$('nsBtn').addEventListener('click', () => nsOpen(!nsp.open));
$('nsList').addEventListener('click', e => {
  const only = e.target.closest('[data-only]');
  if (only) { nsApply(new Set([only.dataset.only])); nsOpen(false); $('nsBtn').focus(); return; }
  const r = e.target.closest('[data-nsv]');
  if (r) { nsp.at = +r.dataset.i; nsToggle(r.dataset.nsv); $('nsQ').focus(); }
});
$('nsList').addEventListener('pointermove', e => {
  const r = e.target.closest('[data-i]'); if (!r || +r.dataset.i === nsp.at) return;
  $('nsList').querySelector('.nsp-row.at')?.classList.remove('at'); r.classList.add('at'); nsp.at = +r.dataset.i;
});
$('nsClear').addEventListener('click', () => { nsApply(new Set()); $('nsQ').focus(); });
$('nsQ').addEventListener('input', e => { nsp.q = e.target.value.trim(); nsp.at = 0; nsRender(); });
$('nsPop').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = nsp.items.length; if (!n) return;
    nsp.at = (nsp.at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; nsRender();
  } else if (e.key === 'Enter' || (e.key === ' ' && e.target.id !== 'nsQ')) {
    // Enter ticks / unticks the highlighted row; Ctrl/⌘+Enter keeps only that one and closes
    e.preventDefault();
    const v = nsp.items[nsp.at]; if (v == null) return;
    if (e.ctrlKey || e.metaKey) { nsApply(v === NS_ALL ? new Set() : new Set([v])); nsOpen(false); $('nsBtn').focus(); }
    else nsToggle(v);
  } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nsOpen(false); $('nsBtn').focus(); }
});
document.addEventListener('pointerdown', e => { if (nsp.open && !e.target.closest('#nsPick')) nsOpen(false); });

// keep the button in step with the select: changed here, by ":ns x", by double-clicking a namespace, or refilled
$('ns').addEventListener('change', () => { if (!state.nsPicking) nsRemember([$('ns').value]); nsLabel(); });
new MutationObserver(() => { nsLabel(); if (nsp.open) nsRender(); }).observe($('ns'), { childList: true });
nsLabel();
