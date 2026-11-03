// Minimal Stripe client using fetch (no SDK needed on Workers)
import { HttpError, toHex } from './util.js';

const API = 'https://api.stripe.com/v1';

function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => typeof item === 'object' ? form(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, item));
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, body) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Payments are not set up yet.');
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body ? form(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, data?.error?.message || 'Stripe request failed.');
  return data;
}

export function createCheckoutSession(env, { submission, user, appUrl }) {
  return stripe(env, 'POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: user.email,
    client_reference_id: submission.id,
    metadata: { submission_id: submission.id, user_id: user.id },
    payment_intent_data: { metadata: { submission_id: submission.id } },
    allow_promotion_codes: 'true',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: submission.price_cents,
        product_data: {
          name: 'Twelve Issues: 12 newsletters',
          description: `12 ready-to-send newsletters from "${submission.title}"`.slice(0, 300),
        },
      },
    }],
    success_url: `${appUrl}/app/submission.html?id=${submission.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/app/submission.html?id=${submission.id}&canceled=1`,
  });
}

export function retrieveCheckoutSession(env, id) {
  return stripe(env, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
}

// Verify the Stripe-Signature header (v1 HMAC-SHA256 scheme)
export async function verifyWebhook(env, payload, header, toleranceSec = 300) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Webhook secret not configured.');
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=')));
  const t = parts.t;
  const sigs = String(header || '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !sigs.length) throw new HttpError(400, 'Bad signature header.');
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new HttpError(400, 'Signature too old.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  if (!sigs.includes(expected)) throw new HttpError(400, 'Signature mismatch.');
  return JSON.parse(payload);
}
