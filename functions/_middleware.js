// Send every visitor to one address so logins (cookies) always match.
// www.twelveissues.com and twelve-issues.pages.dev redirect to https://twelveissues.com
const CANONICAL = 'twelveissues.com';
const ALIASES = new Set(['www.twelveissues.com', 'twelve-issues.pages.dev']);

export async function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (ALIASES.has(url.hostname)) {
    url.hostname = CANONICAL;
    url.protocol = 'https:';
    // 308 keeps POST bodies intact; 301 for normal page views
    const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
    return Response.redirect(url.toString(), status);
  }
  return next();
}
