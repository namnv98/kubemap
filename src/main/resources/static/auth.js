'use strict';
/*
 * Login (when the server has k8s-studio.auth.enabled): who is signed in + logout in the top bar, and back to the
 * login page as soon as any request says the session is gone (401). Viewers get the UI without write actions
 * (state.writeEnabled comes from /api/config, which already accounts for the role).
 */
const auth = { enabled: false, user: null, admin: true };
{
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const r = await origFetch(...args);
    if (r.status === 401 && auth.enabled && !location.pathname.startsWith('/login')) location.href = '/login.html';
    return r;
  };
}
/* EventSource can't see status codes: on an error, ask /api/me (a 401 there redirects via the fetch wrapper) */
function checkSession() { fetch('/api/me').catch(() => {}); }

fetch('/api/me').then(r => r.json()).then(me => {
  Object.assign(auth, { enabled: !!me.authEnabled, user: me.user, admin: !!me.admin });
  if (!auth.enabled) return;
  const el = document.createElement('span');
  el.className = 'user-chip';
  el.title = auth.admin ? 'Quản trị: xem và thay đổi cluster' : 'Chỉ xem: không được thay đổi cluster';
  el.innerHTML = `<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
    <b>${esc(auth.user)}</b><span class="role ${auth.admin ? 'admin' : ''}">${auth.admin ? 'admin' : 'viewer'}</span>
    <a href="/logout" class="logout" title="Đăng xuất"><svg class="i" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg></a>`;
  $('tbSepMe').after(el);
}).catch(() => {});
