// Password hashing, sessions, and access checks
import { HttpError, getCookie, randomToken, sha256, nowIso, toHex } from './util.js';

const ITERATIONS = 100000; // Cloudflare Workers caps PBKDF2 at 100,000 iterations
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'ti_session';

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}

export async function verifyPassword(password, hash, salt) {
  const { hash: candidate } = await hashPassword(password, salt);
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function isAdminEmail(env, email) {
  const list = String(env.ADMIN_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  return list.includes(String(email).toLowerCase());
}

export async function createSession(env, userId) {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, nowIso(SESSION_DAYS * 86400_000)).run();
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export async function destroySession(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function currentUser(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.company, u.role, u.created_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), nowIso()).first();
  if (!row) return null;
  // Keep the admin role in sync with ADMIN_EMAILS
  const shouldBeAdmin = isAdminEmail(env, row.email);
  if (shouldBeAdmin && row.role !== 'admin') {
    await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(row.id).run();
    row.role = 'admin';
  }
  return row;
}

export async function requireUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) throw new HttpError(401, 'Please log in.');
  return user;
}

export async function requireAdmin(env, request) {
  const user = await requireUser(env, request);
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only.');
  return user;
}
