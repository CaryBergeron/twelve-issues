// Shared front-end helpers for Twelve Issues
const TI = (() => {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api/' + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const money = cents => '$' + (cents / 100).toFixed(cents % 100 ? 2 : 0);
  const date = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const datetime = s => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const STATUS = { awaiting_payment: 'Waiting for payment', paid: 'Ready to write', generating: 'Writing', complete: 'Ready', failed: 'Needs a retry' };

  let me = null;
  async function loadMe() {
    try { me = (await api('auth/me')).user; } catch { me = null; }
    return me;
  }

  async function requireLogin({ admin = false } = {}) {
    const user = await loadMe();
    if (!user) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return new Promise(() => {}); }
    if (admin && user.role !== 'admin') { location.href = '/app/'; return new Promise(() => {}); }
    renderNav(user);
    return user;
  }

  function renderNav(user) {
    const nav = $('#nav');
    if (!nav) return;
    if (user) {
      nav.innerHTML = `
        <a href="/app/">Projects</a>
        ${user.role === 'admin' ? '<a href="/admin/">Admin</a>' : ''}
        <a href="#" id="logout" class="hide-sm">Log out</a>
        <a class="btn btn-sm" href="/app/new.html">New project</a>`;
      $('#logout').addEventListener('click', async e => { e.preventDefault(); await api('auth/logout', { method: 'POST' }); location.href = '/'; });
    } else {
      nav.innerHTML = `<a href="/#how" class="hide-sm">How it works</a><a href="/#pricing" class="hide-sm">Pricing</a><a href="/login.html">Log in</a><a class="btn btn-sm" href="/signup.html">Get started</a>`;
    }
  }

  function showError(el, msg) { el.textContent = msg; el.className = 'alert alert-error'; el.hidden = false; }
  function showOk(el, msg) { el.textContent = msg; el.className = 'alert alert-ok'; el.hidden = false; }

  // Small, safe Markdown renderer for issue bodies
  function md(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let html = '', list = null, para = [];
    const inline = s => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); const lvl = Math.min(4, m[1].length + 1); html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; continue; }
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
      flushList(); para.push(line.trim());
    }
    flushPara(); flushList();
    return html;
  }

  function download(filename, content, type = 'text/plain') {
    const blob = new Blob([content], { type: type + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    }
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = old), 1400); }
  }

  function track(type) {
    try { navigator.sendBeacon?.('/api/events', new Blob([JSON.stringify({ type, page: location.pathname, ref: document.referrer })], { type: 'application/json' })); } catch {}
  }

  return { api, esc, $, $$, money, date, datetime, STATUS, loadMe, requireLogin, renderNav, showError, showOk, md, download, copy, track };
})();
