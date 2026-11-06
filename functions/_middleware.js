// Send every visitor to one address so logins (cookies) always match.
// www.twelveissues.com and any *.twelve-issues.pages.dev address redirect to https://twelveissues.com
const CANONICAL = 'twelveissues.com';
const ALIASES = new Set(['www.twelveissues.com', 'twelve-issues.pages.dev']);

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (ALIASES.has(url.hostname) || url.hostname.endsWith('.twelve-issues.pages.dev')) {
    url.hostname = CANONICAL;
    url.protocol = 'https:';
    // 308 keeps POST bodies intact; 301 for normal page views
    const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
    return Response.redirect(url.toString(), status);
  }
  // Refuse cross-site writes to the API (Stripe's webhook has no Origin header, so it passes)
  if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host; } catch {}
      if (host !== url.host) return new Response(JSON.stringify({ error: 'Cross-site request blocked.' }), { status: 403, headers: { 'content-type': 'application/json' } });
    } else if (origin === 'null') {
      return new Response(JSON.stringify({ error: 'Cross-site request blocked.' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
  }
  const res = await next();
  // Never cache API answers (they hold account data)
  if (url.pathname.startsWith('/api/')) {
    const out = new Response(res.body, res);
    if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'no-store');
    return out;
  }
  return res;
}
