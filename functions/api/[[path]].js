// Twelve Issues API: one router for every /api/* route
import { json, error, HttpError, uid, nowIso, readJson, cookie, str, safeParse, logEvent, csv, randomToken, sha256 } from '../_lib/util.js';
import { hashPassword, verifyPassword, createSession, destroySession, currentUser, requireUser, requireAdmin, isAdminEmail, SESSION_COOKIE } from '../_lib/auth.js';
import { createCheckoutSession, retrieveCheckoutSession, verifyWebhook } from '../_lib/stripe.js';
import { planSeries, writeBatch, BATCHES } from '../_lib/ai.js';

const MAX_SOURCE_CHARS = 600_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequest(context) {
  const { request, env, params } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const method = request.method.toUpperCase();
  const route = `${method} /${parts.join('/')}`;
  try {
    const handler = match(route);
    if (!handler) return error('Not found.', 404);
    return await handler.fn({ request, env, ctx: context, args: handler.args });
  } catch (e) {
    if (e instanceof HttpError) return error(e.message, e.status);
    console.error(route, e);
    return error('Something went wrong on our end. Please try again.', 500);
  }
}

// ---------- routing ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^/' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

function match(route) {
  const sp = route.indexOf(' ');
  const method = route.slice(0, sp), path = route.slice(sp + 1);
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (m) return { fn: r.fn, args: m.groups || {} };
  }
  return null;
}

function appUrl(env, request) {
  return (env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');
}
function isSecure(request) { return new URL(request.url).protocol === 'https:'; }

// ---------- public config ----------
on('GET', 'config', async ({ env }) => json({
  price_cents: Number(env.PRICE_CENTS || 1200),
  payments_ready: !!env.STRIPE_SECRET_KEY || env.MOCK_PAYMENTS === '1',
  mock_payments: env.MOCK_PAYMENTS === '1',
  password_reset_email: !!env.RESEND_API_KEY,
}));

on('POST', 'events', async ({ request, env }) => {
  const body = await readJson(request, 10_000);
  const type = str(body.type, 40);
  if (!/^[a-z_]+$/.test(type)) return error('Bad event.');
  const user = await currentUser(env, request);
  await logEvent(env, 'client_' + type, { userId: user?.id, data: { page: str(body.page, 200), ref: str(body.ref, 300) } });
  return json({ ok: true });
});

// ---------- auth ----------
on('POST', 'auth/signup', async ({ request, env }) => {
  const b = await readJson(request, 20_000);
  const email = str(b.email, 200).toLowerCase();
  const password = String(b.password || '');
  if (!EMAIL_RE.test(email)) return error('Please enter a valid email address.');
  if (password.length < 8) return error('Passwords need at least 8 characters.');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return error('That email already has an account. Try logging in.', 409);
  const { hash, salt } = await hashPassword(password);
  const id = uid('u_');
  const role = isAdminEmail(env, email) ? 'admin' : 'user';
  await env.DB.prepare('INSERT INTO users (id, email, name, company, password_hash, password_salt, role, signup_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, email, str(b.name, 120), str(b.company, 160), hash, salt, role, str(b.source, 300)).run();
  const s = await createSession(env, id);
  await logEvent(env, 'signup', { userId: id, data: { source: str(b.source, 300) } });
  return json({ user: { id, email, name: str(b.name, 120), role } }, 201, { 'set-cookie': cookie(SESSION_COOKIE, s.token, { maxAge: s.maxAge, secure: isSecure(request) }) });
});

on('POST', 'auth/login', async ({ request, env }) => {
  const b = await readJson(request, 10_000);
  const email = str(b.email, 200).toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !(await verifyPassword(String(b.password || ''), user.password_hash, user.password_salt))) {
    return error('That email and password do not match.', 401);
  }
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), user.id).run();
  const s = await createSession(env, user.id);
  await logEvent(env, 'login', { userId: user.id });
  return json({ user: { id: user.id, email: user.email, name: user.name, role: isAdminEmail(env, user.email) ? 'admin' : user.role } }, 200,
    { 'set-cookie': cookie(SESSION_COOKIE, s.token, { maxAge: s.maxAge, secure: isSecure(request) }) });
});

on('POST', 'auth/logout', async ({ request, env }) => {
  await destroySession(env, request);
  return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecure(request) }) });
});

// ---------- contact form ----------
on('POST', 'contact', async ({ request, env }) => {
  const b = await readJson(request, 20_000);
  if (str(b.website, 200)) return json({ ok: true }); // honeypot: bots fill hidden fields
  const name = str(b.name, 120), email = str(b.email, 200).toLowerCase(), topic = str(b.topic, 80);
  const book = str(b.book, 200), message = str(b.message, 5000);
  if (!name || !message) return error('Please add your name and a message.');
  if (!EMAIL_RE.test(email)) return error('Please enter a valid email address so we can reply.');
  const user = await currentUser(env, request);
  // Light throttle: at most 5 messages per email per hour
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'contact_message' AND created_at > datetime('now', '-1 hour') AND json_extract(data, '$.email') = ?")
    .bind(email).first();
  if (recent && recent.n >= 5) return error('You have sent several messages in the last hour. We will be in touch soon.', 429);
  await logEvent(env, 'contact_message', { userId: user?.id, data: { name, email, topic, book, message } });
  if (env.RESEND_API_KEY && env.ADMIN_EMAILS) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.FROM_EMAIL || 'Twelve Issues <hello@twelveissues.com>',
          to: env.ADMIN_EMAILS.split(',').map(e => e.trim()).filter(Boolean),
          reply_to: email,
          subject: `Contact: ${topic} from ${name}`,
          text: `From: ${name} <${email}>\nTopic: ${topic}\nBook: ${book || '(none)'}\nAccount: ${user ? user.email : 'not logged in'}\n\n${message}`,
        }),
      });
    } catch (e) { /* the message is already saved; the email is a bonus */ }
  }
  return json({ ok: true });
});

on('GET', 'auth/me', async ({ request, env }) => {
  const user = await currentUser(env, request);
  return json({ user });
});

on('POST', 'auth/forgot', async ({ request, env }) => {
  const b = await readJson(request, 5_000);
  const email = str(b.email, 200).toLowerCase();
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
  if (user && env.RESEND_API_KEY) {
    const token = randomToken(24);
    await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), user.id, nowIso(3600_000)).run();
    const link = `${appUrl(env, request)}/reset.html?token=${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Twelve Issues <hello@twelveissues.com>',
        to: user.email,
        subject: 'Reset your Twelve Issues password',
        text: `Click this link to choose a new password. It works for one hour.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
      }),
    });
    await logEvent(env, 'password_reset_requested', { userId: user.id });
  }
  // Same answer either way so nobody can test which emails have accounts
  return json({ ok: true, email_enabled: !!env.RESEND_API_KEY });
});

on('POST', 'auth/reset', async ({ request, env }) => {
  const b = await readJson(request, 5_000);
  const password = String(b.password || '');
  if (password.length < 8) return error('Passwords need at least 8 characters.');
  const row = await env.DB.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(await sha256(str(b.token, 100)), nowIso()).first();
  if (!row) return error('That reset link has expired. Please request a new one.', 400);
  const { hash, salt } = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, row.user_id),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').bind(nowIso(), row.token_hash),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
  ]);
  return json({ ok: true });
});

// ---------- submissions (customer) ----------
function publicSubmission(s) {
  return {
    id: s.id, kind: s.kind, title: s.title, status: s.status, progress: s.progress, error: s.error,
    price_cents: s.price_cents, paid_at: s.paid_at, comped: !!s.comped,
    source_files: safeParse(s.source_files, []), source_chars: s.source_chars,
    questionnaire: safeParse(s.questionnaire, {}), settings: safeParse(s.settings, {}),
    plan: (safeParse(s.brief, null)?.issues || []).map(i => ({ number: i.number, label: i.label, theme: i.theme, angle: i.angle })),
    rating: s.rating, feedback: s.feedback,
    created_at: s.created_at, completed_at: s.completed_at,
  };
}

async function ownedSubmission(env, user, id) {
  const s = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  if (!s || (s.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'We could not find that project.');
  return s;
}

on('GET', 'submissions', async ({ request, env }) => {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, title, status, progress, price_cents, paid_at, created_at, completed_at,
     (SELECT COUNT(*) FROM issues i WHERE i.submission_id = s.id) AS issue_count
     FROM submissions s WHERE user_id = ? ORDER BY created_at DESC`).bind(user.id).all();
  return json({ submissions: results });
});

on('POST', 'submissions', async ({ request, env }) => {
  const user = await requireUser(env, request);
  const b = await readJson(request, 3_000_000);
  const kind = b.kind === 'business' ? 'business' : 'author';
  const title = str(b.title, 200);
  if (!title) return error(kind === 'author' ? 'Please give us your book title.' : 'Please give us your business name.');
  const sourceText = String(b.source_text || '').replace(/\u0000/g, '').slice(0, MAX_SOURCE_CHARS);
  const q = {};
  for (const [k, v] of Object.entries(b.questionnaire || {})) if (/^[a-z_]{1,40}$/.test(k)) q[k] = str(v, 2000);
  const answered = Object.values(q).filter(Boolean).join(' ').length;
  if (sourceText.length < 500 && answered < 200) {
    return error('Give us a little more to work with: upload a document, or answer more of the questions.');
  }
  const sIn = b.settings || {};
  const settings = {
    tone: str(sIn.tone, 60) || 'warm and conversational',
    cadence: ['monthly', 'biweekly', 'weekly'].includes(sIn.cadence) ? sIn.cadence : 'monthly',
    start_month: Number.isInteger(sIn.start_month) && sIn.start_month >= 0 && sIn.start_month < 12 ? sIn.start_month : new Date().getMonth(),
    cta_url: str(sIn.cta_url, 400),
    audience: str(sIn.audience, 400),
    extra: str(sIn.extra, 1500),
  };
  const files = (Array.isArray(b.source_files) ? b.source_files : []).slice(0, 20).map(f => ({ name: str(f.name, 200), chars: Number(f.chars) || 0 }));
  const id = uid('s_');
  const price = Number(env.PRICE_CENTS || 1200);
  await env.DB.prepare(`INSERT INTO submissions (id, user_id, kind, title, source_files, source_text, source_chars, questionnaire, settings, price_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, kind, title, JSON.stringify(files), sourceText, sourceText.length, JSON.stringify(q), JSON.stringify(settings), price).run();
  await logEvent(env, 'submission_created', { userId: user.id, submissionId: id, data: { kind, chars: sourceText.length, files: files.length } });
  return json({ id }, 201);
});

on('GET', 'submissions/:id', async ({ request, env, args }) => {
  const user = await requireUser(env, request);
  const s = await ownedSubmission(env, user, args.id);
  const issues = s.status === 'awaiting_payment' ? [] : (await env.DB.prepare(
    'SELECT number, month_label, subject, preview_text, headline, body, cta, image_idea FROM issues WHERE submission_id = ? ORDER BY number'
  ).bind(s.id).all()).results;
  return json({ submission: publicSubmission(s), issues });
});

on('POST', 'submissions/:id/checkout', async ({ request, env, args }) => {
  const user = await requireUser(env, request);
  const s = await ownedSubmission(env, user, args.id);
  if (s.status !== 'awaiting_payment') return json({ already_paid: true });
  if (env.MOCK_PAYMENTS === '1') {
    await markPaid(env, s, { sessionId: 'mock_' + s.id, amount: s.price_cents, status: 'paid' });
    return json({ already_paid: true, mock: true });
  }
  const session = await createCheckoutSession(env, { submission: s, user, appUrl: appUrl(env, request) });
  await env.DB.prepare('UPDATE submissions SET stripe_session_id = ?, updated_at = ? WHERE id = ?').bind(session.id, nowIso(), s.id).run();
  await logEvent(env, 'checkout_started', { userId: user.id, submissionId: s.id });
  return json({ url: session.url });
});

// Called when Stripe sends the customer back, in case the webhook is slower than the redirect
on('POST', 'submissions/:id/confirm', async ({ request, env, args }) => {
  const user = await requireUser(env, request);
  const s = await ownedSubmission(env, user, args.id);
  if (s.status !== 'awaiting_payment') return json({ paid: true });
  const b = await readJson(request, 2_000);
  const sessionId = str(b.session_id, 200) || s.stripe_session_id;
  if (!sessionId) return json({ paid: false });
  const session = await retrieveCheckoutSession(env, sessionId);
  if (session.payment_status === 'paid' && session.metadata?.submission_id === s.id) {
    await markPaid(env, s, { sessionId: session.id, intent: session.payment_intent, amount: session.amount_total, status: 'paid' });
    return json({ paid: true });
  }
  return json({ paid: false });
});

async function markPaid(env, s, { sessionId, intent = null, amount, status }) {
  const res = await env.DB.prepare("UPDATE submissions SET status = 'paid', paid_at = ?, comped = ?, stripe_session_id = COALESCE(?, stripe_session_id), updated_at = ? WHERE id = ? AND status = 'awaiting_payment'")
    .bind(nowIso(), status === 'comped' ? 1 : 0, sessionId, nowIso(), s.id).run();
  if (res.meta.changes) {
    await env.DB.prepare('INSERT OR IGNORE INTO payments (id, submission_id, user_id, stripe_session_id, stripe_payment_intent, amount_cents, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid('p_'), s.id, s.user_id, sessionId, intent, amount ?? 0, status).run();
    await logEvent(env, status === 'comped' ? 'submission_comped' : 'payment_received', { userId: s.user_id, submissionId: s.id, data: { amount } });
  }
}

// Runs the next step of generation. The browser calls this until progress reaches 4.
on('POST', 'submissions/:id/generate', async ({ request, env, args }) => {
  const user = await requireUser(env, request);
  let s = await ownedSubmission(env, user, args.id);
  if (s.status === 'awaiting_payment') return error('Please complete payment first.', 402);
  if (s.status === 'complete') return json({ status: 'complete', progress: 4 });

  const lock = await env.DB.prepare("UPDATE submissions SET locked_until = ?, status = 'generating', error = NULL, updated_at = ? WHERE id = ? AND (locked_until IS NULL OR locked_until < ?)")
    .bind(nowIso(4 * 60_000), nowIso(), s.id, nowIso()).run();
  if (!lock.meta.changes) return json({ status: 'generating', progress: s.progress, busy: true });

  const sub = { ...s, questionnaire: safeParse(s.questionnaire, {}), settings: safeParse(s.settings, {}) };
  try {
    if (s.progress === 0) {
      const { brief, model, usage } = await planSeries(env, sub);
      await env.DB.prepare('UPDATE submissions SET brief = ?, progress = 1, model = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, locked_until = NULL, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(brief), model, usage.input_tokens || 0, usage.output_tokens || 0, nowIso(), s.id).run();
      await logEvent(env, 'plan_created', { userId: s.user_id, submissionId: s.id });
      return json({ status: 'generating', progress: 1 });
    }
    const brief = safeParse(s.brief, null);
    const batch = BATCHES[s.progress - 1];
    if (!brief || !batch) throw new HttpError(500, 'This project needs a fresh start. Please contact support.');
    const { issues, model, usage } = await writeBatch(env, sub, brief, batch);
    const stmts = issues.map(it => env.DB.prepare(
      `INSERT INTO issues (id, submission_id, number, month_label, subject, preview_text, headline, body, cta, image_idea) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id, number) DO UPDATE SET subject = excluded.subject, preview_text = excluded.preview_text, headline = excluded.headline, body = excluded.body, cta = excluded.cta, image_idea = excluded.image_idea`)
      .bind(uid('i_'), s.id, Number(it.number), brief.issues[it.number - 1]?.label || null, str(it.subject, 200), str(it.preview_text, 300), str(it.headline, 300), String(it.body || '').slice(0, 20_000), str(it.cta, 300), str(it.image_idea, 500)));
    const next = s.progress + 1;
    const done = next >= 4;
    stmts.push(env.DB.prepare(`UPDATE submissions SET progress = ?, status = ?, completed_at = ?, model = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, locked_until = NULL, updated_at = ? WHERE id = ?`)
      .bind(next, done ? 'complete' : 'generating', done ? nowIso() : null, model, usage.input_tokens || 0, usage.output_tokens || 0, nowIso(), s.id));
    await env.DB.batch(stmts);
    if (done) await logEvent(env, 'submission_completed', { userId: s.user_id, submissionId: s.id });
    return json({ status: done ? 'complete' : 'generating', progress: next });
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'Something went wrong while writing. Please try again.';
    await env.DB.prepare("UPDATE submissions SET status = 'failed', error = ?, locked_until = NULL, updated_at = ? WHERE id = ?").bind(msg, nowIso(), s.id).run();
    await logEvent(env, 'generation_failed', { userId: s.user_id, submissionId: s.id, data: { step: s.progress, message: String(e.message || e).slice(0, 500) } });
    return error(msg, 502, { progress: s.progress });
  }
});

on('POST', 'submissions/:id/feedback', async ({ request, env, args }) => {
  const user = await requireUser(env, request);
  const s = await ownedSubmission(env, user, args.id);
  const b = await readJson(request, 10_000);
  const rating = Math.max(1, Math.min(5, Number(b.rating) || 0)) || null;
  await env.DB.prepare('UPDATE submissions SET rating = ?, feedback = ?, updated_at = ? WHERE id = ?').bind(rating, str(b.feedback, 3000), nowIso(), s.id).run();
  await logEvent(env, 'feedback', { userId: user.id, submissionId: s.id, data: { rating } });
  return json({ ok: true });
});

// ---------- Stripe webhook ----------
on('POST', 'stripe/webhook', async ({ request, env }) => {
  const payload = await request.text();
  const event = await verifyWebhook(env, payload, request.headers.get('stripe-signature'));
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const id = session.metadata?.submission_id || session.client_reference_id;
    if (id && session.payment_status === 'paid') {
      const s = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
      if (s) await markPaid(env, s, { sessionId: session.id, intent: session.payment_intent, amount: session.amount_total, status: 'paid' });
    }
  }
  if (event.type === 'charge.refunded') {
    const intent = event.data.object.payment_intent;
    if (intent) await env.DB.prepare("UPDATE payments SET status = 'refunded' WHERE stripe_payment_intent = ?").bind(intent).run();
  }
  return json({ received: true });
});

// ---------- admin ----------
on('GET', 'admin/stats', async ({ request, env }) => {
  await requireAdmin(env, request);
  const one = sql => env.DB.prepare(sql).first();
  const [users, users7, subs, paid, complete, failed, revenue, tokens, rating] = await Promise.all([
    one('SELECT COUNT(*) n FROM users'),
    one("SELECT COUNT(*) n FROM users WHERE created_at > datetime('now','-7 days')"),
    one('SELECT COUNT(*) n FROM submissions'),
    one("SELECT COUNT(*) n FROM submissions WHERE status != 'awaiting_payment'"),
    one("SELECT COUNT(*) n FROM submissions WHERE status = 'complete'"),
    one("SELECT COUNT(*) n FROM submissions WHERE status = 'failed'"),
    one("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE status = 'paid'"),
    one('SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM submissions'),
    one('SELECT AVG(rating) a, COUNT(rating) n FROM submissions WHERE rating IS NOT NULL'),
  ]);
  const byKind = (await env.DB.prepare('SELECT kind, COUNT(*) n FROM submissions GROUP BY kind').all()).results;
  const daily = (await env.DB.prepare(
    `SELECT date(created_at) d, COUNT(*) n FROM submissions WHERE created_at > datetime('now','-30 days') GROUP BY d ORDER BY d`).all()).results;
  return json({
    users: users.n, users_7d: users7.n, submissions: subs.n, paid: paid.n, complete: complete.n, failed: failed.n,
    revenue_cents: revenue.n, input_tokens: tokens.i, output_tokens: tokens.o,
    avg_rating: rating.a ? Math.round(rating.a * 10) / 10 : null, ratings: rating.n, by_kind: byKind, daily,
  });
});

on('GET', 'admin/users', async ({ request, env }) => {
  await requireAdmin(env, request);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.company, u.role, u.signup_source, u.created_at, u.last_login_at,
       (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submissions,
       (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS spent_cents
     FROM users u ORDER BY u.created_at DESC LIMIT 1000`).all();
  return json({ users: results });
});

on('GET', 'admin/submissions', async ({ request, env }) => {
  await requireAdmin(env, request);
  const status = new URL(request.url).searchParams.get('status');
  const where = status ? 'WHERE s.status = ?' : '';
  const stmt = env.DB.prepare(
    `SELECT s.id, s.kind, s.title, s.status, s.progress, s.source_chars, s.price_cents, s.paid_at, s.comped, s.rating,
       s.input_tokens, s.output_tokens, s.error, s.created_at, s.completed_at, u.email
     FROM submissions s JOIN users u ON u.id = s.user_id ${where} ORDER BY s.created_at DESC LIMIT 1000`);
  const { results } = await (status ? stmt.bind(status) : stmt).all();
  return json({ submissions: results });
});

on('GET', 'admin/submissions/:id', async ({ request, env, args }) => {
  await requireAdmin(env, request);
  const s = await env.DB.prepare('SELECT s.*, u.email, u.name AS user_name FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').bind(args.id).first();
  if (!s) return error('Not found.', 404);
  const issues = (await env.DB.prepare('SELECT * FROM issues WHERE submission_id = ? ORDER BY number').bind(s.id).all()).results;
  const events = (await env.DB.prepare('SELECT type, data, created_at FROM events WHERE submission_id = ? ORDER BY id DESC LIMIT 100').bind(s.id).all()).results;
  return json({
    submission: { ...s, source_text: undefined, source_excerpt: (s.source_text || '').slice(0, 5000), questionnaire: safeParse(s.questionnaire, {}), settings: safeParse(s.settings, {}), brief: safeParse(s.brief, null), source_files: safeParse(s.source_files, []) },
    issues, events,
  });
});

on('POST', 'admin/submissions/:id/comp', async ({ request, env, args }) => {
  await requireAdmin(env, request);
  const s = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(args.id).first();
  if (!s) return error('Not found.', 404);
  await markPaid(env, s, { sessionId: null, amount: 0, status: 'comped' });
  return json({ ok: true });
});

on('POST', 'admin/submissions/:id/reset', async ({ request, env, args }) => {
  const admin = await requireAdmin(env, request);
  const s = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(args.id).first();
  if (!s) return error('Not found.', 404);
  if (s.status === 'awaiting_payment') return error('This project has not been paid for yet.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM issues WHERE submission_id = ?').bind(s.id),
    env.DB.prepare("UPDATE submissions SET progress = 0, brief = NULL, status = 'paid', error = NULL, locked_until = NULL, completed_at = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), s.id),
  ]);
  await logEvent(env, 'submission_reset', { userId: admin.id, submissionId: s.id });
  return json({ ok: true });
});

on('GET', 'admin/messages', async ({ request, env }) => {
  await requireAdmin(env, request);
  const { results } = await env.DB.prepare(
    "SELECT id, data, created_at FROM events WHERE type = 'contact_message' ORDER BY id DESC LIMIT 300").all();
  return json({ messages: results.map(r => ({ id: r.id, created_at: r.created_at, ...safeParse(r.data, {}) })) });
});

on('GET', 'admin/events', async ({ request, env }) => {
  await requireAdmin(env, request);
  const { results } = await env.DB.prepare(
    'SELECT e.id, e.type, e.data, e.created_at, e.submission_id, u.email FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 300').all();
  return json({ events: results });
});

on('GET', 'admin/export/:what', async ({ request, env, args }) => {
  await requireAdmin(env, request);
  const what = args.what.replace(/\.csv$/, '');
  let rows, cols;
  if (what === 'users') {
    rows = (await env.DB.prepare(`SELECT u.email, u.name, u.company, u.role, u.signup_source, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submissions,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') AS spent_cents FROM users u ORDER BY u.created_at`).all()).results;
    cols = ['email', 'name', 'company', 'role', 'signup_source', 'created_at', 'last_login_at', 'submissions', 'spent_cents'];
  } else if (what === 'submissions') {
    rows = (await env.DB.prepare(`SELECT s.id, u.email, s.kind, s.title, s.status, s.source_chars, s.price_cents, s.paid_at, s.comped, s.rating, s.feedback,
      s.input_tokens, s.output_tokens, s.questionnaire, s.settings, s.created_at, s.completed_at FROM submissions s JOIN users u ON u.id = s.user_id ORDER BY s.created_at`).all()).results;
    cols = ['id', 'email', 'kind', 'title', 'status', 'source_chars', 'price_cents', 'paid_at', 'comped', 'rating', 'feedback', 'input_tokens', 'output_tokens', 'questionnaire', 'settings', 'created_at', 'completed_at'];
  } else if (what === 'issues') {
    rows = (await env.DB.prepare(`SELECT i.submission_id, s.title, u.email, i.number, i.month_label, i.subject, i.preview_text, i.headline, i.body, i.cta, i.image_idea
      FROM issues i JOIN submissions s ON s.id = i.submission_id JOIN users u ON u.id = s.user_id ORDER BY i.submission_id, i.number`).all()).results;
    cols = ['submission_id', 'title', 'email', 'number', 'month_label', 'subject', 'preview_text', 'headline', 'body', 'cta', 'image_idea'];
  } else return error('Unknown export.', 404);
  return new Response(csv(rows, cols), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="twelve-issues-${what}-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
});
