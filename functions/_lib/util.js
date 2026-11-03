// Shared helpers for Twelve Issues API

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function error(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function uid(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 18);
}

export function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);
}

export async function readJson(request, maxBytes = 2_500_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'That upload is too large. Try a smaller file or fewer files.');
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid request body.'); }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name, value, { maxAge, secure = true } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export function str(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

export function safeParse(text, fallback = null) {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

export async function logEvent(env, type, { userId = null, submissionId = null, data = null } = {}) {
  try {
    await env.DB.prepare('INSERT INTO events (user_id, submission_id, type, data) VALUES (?, ?, ?, ?)')
      .bind(userId, submissionId, type, data ? JSON.stringify(data) : null).run();
  } catch (e) { /* analytics must never break a request */ }
}

export function csv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\r\n');
}
