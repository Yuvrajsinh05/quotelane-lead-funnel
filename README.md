# QuoteLane: auto insurance lead funnel

A Next.js 16 + TypeScript + Postgres lead funnel: landing page, multi-step form (A/B split), affiliate tracking, URL prefill, a lead-capture API, and partner delivery through a transactional outbox.

- **Live:** https://quotelane-lead-funnel.vercel.app
- **Try a prefilled affiliate link:** https://quotelane-lead-funnel.vercel.app/?click_id=abc123&aff_id=42&channel=email&zip=90210&first_name=Sam&email=sam%40example.com&insured=yes&year={sub5}
- **Architecture, with diagrams:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Tests:** 103 unit, 30 integration (real Postgres), 4 end-to-end (real browser, mobile viewport)

---

## Part 1: The build

### Running it

```bash
cp .env.example .env          # defaults work locally
npm install
npm run db:up                 # Postgres 17 in Docker (port 54329) + a test database
npm run db:migrate            # apply drizzle/ migrations
npm run dev                   # http://localhost:3000
```

Optional local partner, so deliveries can be watched without an external service:

```bash
node scripts/fake-partner.mjs 4555 ok      # modes: ok | slow | fail | flaky
# then in .env: PARTNER_WEBHOOK_URL=http://127.0.0.1:4555/leads
```

| Command | What it runs |
|---|---|
| `npm run test:unit` | Pure domain logic: sanitizing, prefill, tracking, split rules, step engine, validation, sealing, log redaction |
| `npm run test:integration` | Lead service + outbox against real Postgres: idempotency, 24h dedupe, concurrency races, rate limits, retry/timeout, exactly-one-sender |
| `npm run build && npm run test:e2e` | Playwright on a Pixel 7 viewport against the production build |
| `npm run typecheck` / `npm run lint` | Strict TS / ESLint |

`npm test` goes through `scripts/vitest.mjs`, a small launcher that works around a Windows-only problem: when the terminal's drive letter is lower-case (`c:\`), Vitest loads twice and fails with "failed to find the current suite".

### Deploying (Vercel)

1. Import the repo into Vercel.
2. Add a Postgres database from the Vercel Marketplace (any serverless Postgres works) and expose its **pooled** URL as `DATABASE_URL`.
3. Set `APP_SECRET` (32+ random chars), `CRON_SECRET`, `SPLIT_PERCENT_B`, and `PARTNER_WEBHOOK_URL` (e.g. a webhook.site URL). Optionally set `PARTNER_WEBHOOK_SECRET` and `PARTNER_SOURCE_IDS`.
4. The `vercel-build` script runs `drizzle-kit migrate` before `next build`, so the schema is always in step with the code that ships.
5. `vercel.json` registers the recovery cron. The Hobby plan allows one run per day, which is fine for a safety net (see delivery below).

### Testing each part by hand

| Part | Try this |
|---|---|
| Landing + form | Open `/`, enter a ZIP, then step through. Bad input (e.g. ZIP `1234`) shows a clear error under the field. Back and the browser's Back button both work. Refresh mid-form and your answers survive. |
| Tracking | Open `/?click_id=abc123&aff_id=42&channel=email`, then submit. The `leads` row has `aff_click_id`, `aff_id`, `channel` and our own `ql_click_id`. |
| Prefill, all valid | `/?click_id=abc123&aff_id=42&channel=email&zip=90210&first_name=Sam&email=sam%40example.com&insured=yes&year={sub5}&variant=b` lands straight on the contact step. Variant B has only ZIP + insured before it, and both are prefilled. |
| Prefill, junk | `/?zip=00000&phone=abc&email=[EMAIL]&year=1850&first_name=%25%25first%25%25` shows the normal landing page with nothing prefilled and no macro text visible. |
| PII stripping | With any prefill link, the address bar ends up as `/quote?step=…`. Check DevTools → Network: the first response is a `303` with `Referrer-Policy: no-referrer`. |
| Split | `/quote` repeatedly shows the same version (`<main data-variant>`). `?variant=b` forces B for this browser session only; `?variant=clear` exits. A Googlebot UA always gets A. `GET /api/health` shows the active split. |
| API | `POST /api/leads` with `Idempotency-Key`. Same key again returns the same lead (`200`, `Idempotent-Replayed: true`). A new key with the same email/phone returns `409`. The 11th request from one IP in 10 minutes returns `429` + `Retry-After`. |
| Partner | Point `PARTNER_WEBHOOK_URL` at webhook.site, submit, and watch one signed JSON POST arrive. Use `fake-partner.mjs … slow` to see the thank-you page still return in under 100 ms. |

### Design decisions and trade-offs

**Postgres, not SQLite.** Vercel functions have ephemeral, per-instance disks, so SQLite would lose leads and couldn't dedupe across instances. Postgres also provides what correctness needs here: transactions, unique constraints, advisory locks and atomic `UPDATE … RETURNING`.

**A pure domain layer.** Everything that decides anything (sanitizing, prefill, tracking merge, variant resolution, step skipping, validation) lives in `src/domain/` with no framework or DB imports. The proxy, API route and UI are thin adapters over it, which is why the edge cases are cheap to test exhaustively. The same validators run in the browser (for user experience) and on the server (as the authority).

**The proxy redirect removes PII from the URL before any page renders.** `src/proxy.ts` (Next 16's name for middleware) reads tracking and prefill parameters, stores them in cookies, and answers with a `303` to the same path with those parameters removed. The PII-bearing URL never produces an HTML document, so no script, analytics tag, page title, history entry or `Referer` ever sees it. Clearing the URL in the browser with `history.replaceState` would run *after* the page and its scripts had loaded, which is too late.

**The server decides what was prefilled.** Prefill values travel in an AES-256-GCM sealed, HttpOnly cookie (expiry inside the ciphertext). On submit, the API unseals it and compares it with the submitted values, storing per field whether it came from the link, was typed, or was prefilled and then edited (`field_provenance`). The browser can't forge this.

**Idempotency + race-safe dedupe.** Each form session generates one `Idempotency-Key` and reuses it on every submit attempt, so double-clicks and network retries can't create two leads. Inside one transaction the API takes transaction-scoped advisory locks on the key, email and phone, in sorted order so two transactions can't deadlock. It then checks the idempotency key, then runs the 24-hour duplicate check, then inserts. Without the locks, two concurrent submits with the same email would both pass the check. A unique index can't express "within 24 hours". `UNIQUE(idempotency_key)` remains as a backstop. If a key is reused with a *different* body, the API returns `422` instead of silently replaying.

**Partner delivery via a transactional outbox.** The lead, the consent record and a `partner_deliveries` row are committed together, then the API responds. Delivery runs in `after()`, after the response has been sent:

- *Claiming a lead* is one atomic `UPDATE … WHERE status IN (pending, retry_wait) AND attempts < 2 … RETURNING`. Only one worker (the `after()` hook, the cron job, another instance) can ever get the row back, so we never send a lead twice from our side.
- *Each attempt* has a 5-second timeout. We retry once on timeout, network errors, `5xx`, `408`, `425` and `429`, but not on other `4xx` (retrying the same payload can't fix it). The 2-attempt cap is part of the SQL condition itself, not only application code.
- *Status updates are guarded*: a worker that stalls past its lease can't overwrite the result of the worker that replaced it.
- *Recovery:* if an instance dies mid-delivery, the lease expires and the cron sweep picks the row up again. Every HTTP attempt is logged to `delivery_attempts`.
- *The honest limit:* exactly-once delivery over a network is impossible. If the partner receives attempt 1 but its response times out, we can't know. So every request carries `Idempotency-Key: <lead_id>` and the lead id in the body for the partner to dedupe on. Requests are also HMAC-signed (`X-QuoteLane-Signature`).

**Rate limiting in Postgres.** A fixed-window counter via one atomic upsert per rule (10 per 10 minutes, 30 per hour per IP), with the IP stored only as an HMAC. In-memory limiters don't work on serverless, because each instance has its own memory. Trade-off: fixed windows allow bursts at window edges.

**Consent is immutable and versioned.** The browser says *which* consent version it showed. The server stores the text it holds for that version, plus a server timestamp, IP and user agent from the request (never the body), and the page URL with any query string removed.

**Smaller calls:**
- **ZIP:** a valid prefilled ZIP on `/` skips the landing page.
- **Contact:** first/last name, email and phone are on one screen. That makes it "the contact step" the spec refers to, and it's where consent lives.
- **Back after a skip:** Back walks through *every* step, including prefilled ones. Continue skips forward over answered steps.
- **Mid-funnel switch:** if the split changes mid-form, the stored `variant` is the one the visitor actually saw, with `variant_source = mismatch`.

**Phone validation follows the spec, not strict NANP rules.** Strict rules reject an exchange (middle 3 digits) starting with 0 or 1, but the spec's own example `+1 (555) 123-4567` has exchange `123`. I enforce structure (10 digits, valid area code, no N11 codes, not one repeated digit) and leave real deliverability to a carrier lookup, which is listed below.

### How prefill handles bad, missing or unreplaced values

Every value goes through two layers:

1. **Clean** (`domain/sanitize.ts`):
   - Values longer than 512 chars are dropped.
   - One extra layer of percent-encoding is decoded (`sam%2540…`).
   - Control and zero-width characters are removed, whitespace is collapsed and trimmed.
   - Unreplaced macros become "missing": `{x}`, `{{x}}`, `[X]`, `%%x%%`, `$x$`, `<x>`, `#x#`, or anything containing a brace or `%%`. So do null-ish strings (`null`, `undefined`, `n/a`…).
2. **Normalize and validate per field** (`domain/fields.ts`):
   - **ZIP:** 5 digits or ZIP+4. `00000` and `000xx` are rejected.
   - **Year:** 1981 (when standard VINs began) to next year.
   - **Phone:** NANP structure. `+1`, spaces, dots and brackets are accepted.
   - **Email:** lower-cased, length limits, real TLD. An unencoded `+` that the URL parser turned into a space is restored.
   - **Names:** Unicode letters only. ALL-CAPS and all-lowercase are title-cased.
   - **Insured:** yes/y/true/1 and no/n/false/0.

Anything invalid is dropped silently and its step is shown as normal. Nothing junk is ever shown to the visitor. Parameter names are matched case-insensitively and common aliases are accepted (`zipcode`, `fname`, `vehicle_year`…). Tracking values follow the same pipeline with strict character sets. Junk can't break anything because every reader (proxy, page, API) re-validates cookie contents instead of trusting them.

### Keeping personal data out of logs and third parties

- **URL:** stripped by the proxy redirect before any page renders, as above.
- **Referer:** `strict-origin-when-cross-origin` site-wide, `no-referrer` on the redirect, and our URLs never contain PII anyway.
- **Third parties:** a strict CSP (`default-src 'self'`, `connect-src 'self'`) means no third-party script can load and the browser can't send data anywhere else.
- **Page titles:** static strings.
- **Cookies:** the prefill cookie is encrypted and HttpOnly, lasts 2 hours, and is deleted on successful submit. Funnel pages are `Cache-Control: private, no-store` and `noindex`.
- **Logs:** an *allow-list* logger (`server/logger.ts`). Only known-safe keys (ids, statuses, timings, error classes) are written; anything else becomes `[redacted]`. Errors are cut to their first line because Postgres errors can echo values in DETAIL lines. Request URLs and query strings are never logged.
- **Partner responses:** discarded unread, since partners sometimes echo PII back.
- **Rate-limit table:** stores HMAC(IP), not the IP.
- **Residual risk I can't close in code:** the hosting platform's own edge request log records the *first* URL, before the redirect. In production I'd add log-drain scrubbing, or ask affiliates to pass prefill in the URL fragment (`#email=…`), which browsers never send to servers.

### What I'd change before real traffic

1. **Rate limiting and bots:** a Redis/edge-KV sliding-window limiter, plus a challenge (CAPTCHA/Turnstile-style) on suspicious submits. Verify crawler IPs by reverse DNS instead of trusting the User-Agent.
2. **Queue:** a real queue with a dead-letter queue and a replay tool, instead of `after()` + a once-a-day cron. Alerting on delivery failure rate and partner latency, plus a per-partner circuit breaker.
3. **Validation and data protection:**
   - A carrier/HLR phone lookup, an email deliverability check, and a ZIP database. Reject 555-01xx fictional numbers.
   - Encrypt contact fields at rest, with a retention policy and deletion workflows (CCPA).
   - Separate DB roles for the app and for reporting.
4. **Consent evidence:** store a hash of the rendered page, or use a third-party session-certificate vendor. Check against the DNC list before delivery.
5. **Platform:** a nonce-based CSP (drop `'unsafe-inline'`), log-drain PII scrubbing, structured metrics/tracing, and reporting views by brand, channel, variant and source.
6. **Attribution:** a server-side session keyed by our click id, so visitors who block cookies still keep attribution.

---

## Part 2: Short answers

**a. What is a click ID, and why must it survive the whole journey?**
A click ID is a unique identifier that the affiliate's tracking platform generates for one specific click on one specific link. It's the join key between "someone clicked affiliate 42's email" and "that person became a lead or sale". If it gets lost anywhere (a redirect, the split, a refresh, a step change), the lead still arrives but can't be matched to the click. The affiliate doesn't get paid, we can't measure that traffic source, and fraud or quality analysis by source breaks. That's why it's captured on arrival, kept server-side in a first-party cookie, and written onto the lead row itself.

**b. How a server-to-server postback credits us and the affiliate**
1. Affiliate 42 sends a click with their `click_id=abc123`.
2. We store it on arrival, mint our own click id `ql_…`, and save both on the lead.
3. When we deliver the lead, we send the partner our identifiers (lead id / `sub_id=ql_…`) and the affiliate's `click_id`.
4. The partner stores those identifiers on their record. Days later the person buys a policy.
5. The partner's system makes an HTTPS request (the postback) to our tracker, e.g. `GET /postback?sub_id=ql_…&event=sale&amount=…&txn_id=…`.
6. Our tracker looks up `ql_…`, finds the lead (and from it `aff_id=42`, `click_id=abc123`), and records the conversion and revenue for us. The `txn_id` makes duplicate postbacks harmless.
7. We then fire our own postback to affiliate 42's network URL with *their* `click_id=abc123` and the payout, so their platform credits the right click.

No browser is involved at any point, so ad blockers, cookie loss and device changes don't break attribution.

**c. Server-to-server postback vs tracking pixel**
A pixel is an image or script loaded *in the visitor's browser* on a conversion page. It relies on the browser making the call and usually on a third-party cookie to know who converted. A postback is a direct server-to-server HTTPS call carrying an explicit id.
- **Pixels** lose conversions to ad blockers, privacy settings (ITP, third-party cookie phase-out), closed tabs and device changes. They also leak page context to whoever hosts the pixel. Use one only when the converting party can't make server calls (a simple landing page they can only paste a tag into) or for browser-side retargeting.
- **Postbacks** are reliable, can be authenticated and retried, carry no visitor PII, and work for conversions that happen offline or days later, like an insurance sale. They're the default for lead gen and anything worth paying on.

**d. A test conversion doesn't show up. What I'd check, in order**
1. **Did the request reach us?** Check edge/access logs for the postback URL, its status code and timestamp. If nothing arrived: wrong URL or domain, a typo in the path, or firewall/IP allow-listing.
2. **Status code:** a `4xx` (auth token, signature or missing parameter) or `5xx` points at our side.
3. **Click ID / macro:** did the advertiser actually fill in the macro, or send `{click_id}` literally? Is it the right parameter name, encoded correctly, and not truncated?
4. **Does that ID exist** in our tracker? For a test, was a real test click generated first through the tracking link, and is it the right offer, affiliate and environment (staging vs prod)?
5. **Attribution rules:** has the click expired (lookback window)? Is it a duplicate transaction id, a disallowed or wrong event name, or a test-mode flag the reporting filters out?
6. **Reporting layer:** time zone, filters, delayed aggregation or cache. Is the conversion stored but not yet visible, or sitting in a pending/rejected status?

**e. Why the affiliate's click ID is stored separately from ours**
They identify different things in different systems. The affiliate's id is opaque to us: their format, their uniqueness guarantees, possibly reused or empty, possibly identical across two networks. Our id is under our control: guaranteed unique, brand-prefixed and always present (organic traffic too). Keeping both lets us:
- Dedupe and join on our own id without trusting theirs.
- Send *their* id back to *them* in postbacks, exactly as they gave it.
- Stay correct when several networks or brands send traffic.
- Avoid a collision between two networks' ids corrupting attribution.

In the schema, `aff_click_id` and `ql_click_id` are separate columns for exactly this reason.

---

## Part 3: Judgment calls

**f. Kill switch vs sticky.** *Decision: at 0 and 100 the setting overrides stickiness; between 1 and 99, stickiness wins.*
- **Why:** an operator sets 0 or 100 because a version is broken or has won. Continuing to serve a broken version to already-assigned visitors costs leads and possibly consent compliance, which is worse than a version switch.
- **Cost of a switch:** the two versions share one form state, so switching mid-form keeps every answer. The visitor just sees the extra (or fewer) questions.
- **What the middleware does:**
  - **0:** everyone gets A.
  - **100:** everyone gets B.
  - **1–99:** existing visitors keep their stored version. New visitors are bucketed by a hash of their visitor id, so raising the percentage only ever moves visitors A→B.
- **Trade-off:** at 0/100 the stored sticky cookie is deliberately *not* rewritten, so if the experiment is reopened (say 0 → 50), the original groups come back intact and the test isn't polluted. A visitor who returns during a kill switch sees the other version, and their lead is labelled `variant_source = killswitch` so analysis can exclude it.

**g. Testing B on production at 0%.** Visit `/?variant=b`:
- The forced choice overrides the kill switch and is stored in a **session-only** cookie (`ql_vo`, no expiry), so it covers every step but disappears when the browser closes. `/?variant=clear` removes it immediately.
- It never touches the sticky cookie, so nothing about my long-term assignment changes, and no one else is affected (it's my browser's cookie).
- Leads submitted while forced are stored with `variant_source = forced` and `is_test = true`, and the partner payload carries `test: true`. They're excluded from experiment results, and the partner can drop them.

Trade-off: anyone who learns `?variant=b` can see B. That's acceptable because it only changes which version of a public form they see. If it mattered, I'd require a signed token (`?variant=b&sig=…`).

**h. `channel=sms` with no SMS-specific setup.** The visitor's experience doesn't change and the lead is **never dropped**: a consented lead is revenue and a person waiting for quotes, and missing config is our problem, not theirs.
- **Routing:** `channel=sms` is still captured and stored. Routing looks for an `sms` entry in `PARTNER_SOURCE_IDS`, doesn't find one, and uses the `default` profile.
- **Flags:** the lead row records `channel = sms`, `routing_profile = default`, `routing_fallback = true`, and a warning is logged.
- **Reporting:** because `channel` is stored on our side independently of partner config, SMS traffic is always separable in our own reports. `routing_fallback` gives us a precise list of leads to reconcile or re-attribute once an SMS source id exists.
- **Unknown channels:** `channel=push` and similar are kept as `channel = unknown` + `channel_raw = push`, so nothing becomes invisible.

**i. Two brands, one partner, same IDs, fixed tracking fields.**
- **In our reporting:** every lead row has `brand` (from `BRAND_ID`), so our own reports split trivially.
- **In the partner's:** we can't add fields, so we put the brand *into the value* of a field we already own. Our click id travels in the partner's `sub_id` field and is brand-prefixed (`BRAND_CLICK_PREFIX`: `ql_01J…` for QuoteLane, e.g. `xb_01J…` for the second brand). The partner can filter or group by prefix in their own reports without any schema change.
- **Postbacks:** they echo `sub_id` back, and the prefix routes each conversion to the right brand's tracker.
- **Trade-off:** it depends on the partner's reporting being able to filter on a prefix (or on us exporting by prefix), and the prefix must never change once leads are in flight. If the partner offered even one free-form field, a dedicated brand value there would be cleaner.

---

*Fictional brand, partner and data throughout. Vehicle makes are the real manufacturer names, because a car insurance form needs them; no real company APIs are used.*
