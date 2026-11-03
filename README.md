# Twelve Issues

**One upload. One year of newsletters.** Customers upload a manuscript or business content (PDF, DOCX, EPUB, TXT) and/or answer a questionnaire, pay $12 (a dollar an issue), and get 12 ready-to-send newsletters.

## How it is built
- **Front end:** static pages in `public/` (no build step). Files are read in the browser (PDF.js, Mammoth, JSZip), so only text is sent to the server.
- **API:** Cloudflare Pages Functions in `functions/api/[[path]].js`.
- **Database:** Cloudflare D1 `twelve-issues` (schema in `schema.sql`).
- **Payments:** Stripe Checkout, $12 per project (`PRICE_CENTS`), confirmed by webhook and on return.
- **Writing:** Claude (`AI_MODEL`). Step 1 plans the year; steps 2 to 4 write issues 1 to 4, 5 to 8, 9 to 12. The browser drives the steps and resumes if a customer leaves.
- **Admin:** `/admin/` for stats, projects, users, activity, and CSV exports. Admins are the emails in `ADMIN_EMAILS`.

## Pages
| Path | Purpose |
|---|---|
| `/` | Landing page and pricing |
| `/signup.html`, `/login.html`, `/forgot.html`, `/reset.html` | Accounts |
| `/app/` | Customer projects |
| `/app/new.html` | New project wizard |
| `/app/submission.html?id=` | Payment, progress, issue viewer, downloads, feedback |
| `/admin/` | Admin dashboard |

## Environment settings (Cloudflare dashboard, Settings, Variables and Secrets)
| Name | Type | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | From console.anthropic.com |
| `STRIPE_SECRET_KEY` | Secret | `sk_live_...` (or `sk_test_...` while testing) |
| `STRIPE_WEBHOOK_SECRET` | Secret | `whsec_...` from the Stripe webhook below |
| `ADMIN_EMAILS` | Secret | Comma-separated admin emails |
| `RESEND_API_KEY`, `FROM_EMAIL` | Secret, optional | Enables password reset emails |
| `APP_URL`, `PRICE_CENTS`, `AI_MODEL` | In `wrangler.toml` | Change there and push |

Stripe webhook: endpoint `https://twelveissues.com/api/stripe/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`.

## Local testing
```
npm install
npx wrangler d1 execute twelve-issues --local --file schema.sql
npx wrangler pages dev --port 8788
```
Create `.dev.vars` with `MOCK_AI=1`, `MOCK_PAYMENTS=1`, `ADMIN_EMAILS=you@example.com` to test without real keys.
