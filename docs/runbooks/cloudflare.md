# Cloudflare: Turnstile now, proxy and WAF at launch

Cloudflare does two jobs here. **Turnstile** is a CAPTCHA on the auth forms, and Supabase Auth (GoTrue) verifies its tokens; the code has shipped and does nothing until the keys are set (§ 1). The **proxy** is DNS, TLS, CDN and WAF in front of the IONOS VPS. It is configuration only, applied once the server and domain exist (§ 2 to § 8). Cloudflare, Inc. is in `docs/sub-processors.md`. Its DPA and transfer basis are pre-launch counsel items there.

Every step ends with a check the owner can run from a laptop. None of them needs a load test.

## 1. Turnstile (do this first; it needs no VPS)

1. Cloudflare dashboard → **Turnstile** → **Add widget**. Hostnames: the production domain (add the staging one if there is one). Widget mode: **Managed**. Leave pre-clearance **off**: pre-clearance sets `cf_clearance` on our domain through `/cdn-cgi/`, and that needs the proxy.
2. **Site key** → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in the app host's environment. The variable is inlined at build time, so rebuild and redeploy after setting it. It is public, and it is the only switch: without it the widget does not render and the CSP names no Cloudflare origin (`lib/security/headers.ts`).
3. **Secret key** → Supabase dashboard → **Authentication → Attack Protection** (labelled "Bot and Abuse Protection" in some versions) → enable **CAPTCHA protection**, provider **Turnstile**, paste the secret. It is never stored in this repository or the app host's environment.
4. Do steps 2 and 3 together. With the secret set and no site key, GoTrue refuses every sign-in, sign-up and magic link, because no form sends a token. With the site key set and no secret, the widget shows but nothing is enforced.

**Verify:**
- `/login`, `/signup` and `/magic-link` show the check above the submit button. A step-up password prompt shows it too; the MFA-code prompt does not, because it never calls GoTrue's sign-in.
- Sign in through the form: it works.
- Close the residual, the direct-to-GoTrue path that skips the app:
  ```bash
  curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "content-type: application/json" \
    -d '{"email":"nobody@example.com","password":"wrong-password"}'
  ```
  It must answer `captcha_failed` (the message starts "captcha protection: request disallowed"), not `invalid_credentials`. Send the same body to `/auth/v1/otp` and `/auth/v1/signup`: both must also answer `captcha_failed`.
- The CSP on `/login` (`curl -sSI https://<domain>/login`) has `https://challenges.cloudflare.com` in `script-src` and `frame-src`, and in no other directive.

GoTrue passes the client IP it sees to Cloudflare's verification. For a sign-in through the app, that IP is the app server's. Cloudflare treats the IP as optional, so this is expected to pass; the "sign in through the form" check above is what confirms it.

## 2. DNS through the proxy

1. Add the domain to Cloudflare and move the nameservers at the registrar.
2. Create `A` (and `AAAA` if the VPS has IPv6) records for the apex and `www`, pointing at the VPS, set to **Proxied** (orange cloud). Leave the Brevo domain-authentication records (`docs/email-setup.md`) as **DNS only**: mail records must not be proxied.
3. Keep `NEXT_PUBLIC_SITE_URL` at the public `https://` domain. Supabase's Site URL and redirect list, the Stripe webhook and OAuth URLs, and the runner URLs in Vault all keep that domain.

**Verify:** `dig +short <domain>` returns Cloudflare addresses, not the VPS IP. `curl -sSI https://<domain>/login` shows `server: cloudflare` and a `cf-ray` header.

## 3. TLS: Full (strict) with an origin certificate

1. **SSL/TLS → Overview → Full (strict).** Never Flexible: Flexible sends the origin leg over plain HTTP, and `upgrade-insecure-requests` plus HSTS then loop.
2. **SSL/TLS → Origin Server → Create certificate** for the apex and `*.<domain>`. Install it and its key on the VPS's reverse proxy (or on Next if it terminates TLS). The key stays on the server.
3. **Edge Certificates:** Always Use HTTPS **on**; Minimum TLS Version **1.2**.

**Verify:** the site loads over HTTPS with no browser warning. On the server, `curl -skv --resolve <domain>:443:127.0.0.1 https://<domain>/login` shows the origin certificate (issuer "Cloudflare Origin" or similar). That certificate is valid only behind the proxy, which is the point.

## 4. Origin firewall: only Cloudflare reaches 80 and 443

Allow inbound 80 and 443 **only** from Cloudflare's published ranges, <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6>. Keep SSH on its own rule, limited to the founder's IPs or a key-only bastion. Example with `ufw`:

```bash
for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow proto tcp from "$ip" to any port 80,443
done
sudo ufw deny 80/tcp && sudo ufw deny 443/tcp
```

The ranges change rarely. Re-run this when Cloudflare announces a change. Without this rule anyone who learns the VPS IP bypasses the WAF, the rate limits and the cache rules. Authenticated Origin Pulls (mTLS from Cloudflare to the origin) is a stronger option, if the reverse proxy is configured for it.

**Verify:** from a laptop, `curl -m 10 -skI --resolve <domain>:443:<VPS IP> https://<domain>/login` times out. Through the proxy, the same page loads.

## 5. HSTS

The app already sends `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on an `https://` deployment (`lib/security/headers.ts`). Leave Cloudflare's own HSTS setting **off**, so one place defines the header. If it is switched on, its values must match exactly. Submitting the domain to the browsers' preload list is a separate, hard-to-reverse decision. Make it only once every subdomain serves HTTPS.

**Verify:** `curl -sSI https://<domain>/login | grep -i strict-transport` prints exactly one header.

## 6. Cache rules: cache only static assets

**Never cache authenticated HTML, `/api`, `/pay`, `/auth` or `/account`.** Every page is per user and per session. A cached page serves one person's workspace to the next visitor. Cloudflare does not cache HTML by default, but it does cache by file extension, and an explicit rule protects against a later default change.

**Caching → Cache Rules**, in this order:
1. **Bypass cache:** *all incoming requests*.
2. **Eligible for cache**, placed after rule 1 (when both match, the later rule wins): `starts_with(http.request.uri.path, "/_next/static/") or http.request.uri.path eq "/icon.svg"` (`app/icon.svg` is the only public asset today; add any new file under `public/` here). Edge TTL: **respect origin**. Next sends `immutable` for hashed static files.

Do not turn on Cache Everything or APO. Leave Rocket Loader **off**: it rewrites script tags and breaks the nonce CSP. Leave Email Obfuscation **off** too: it injects a script without the nonce.

**Verify:** request `/_next/static/<any chunk>` twice; the second answers `cf-cache-status: HIT`. `/login`, a signed-in page, `/api/stripe/webhook` (GET), `/pay/<anything>` and `/auth/callback` all answer `cf-cache-status: BYPASS` or `DYNAMIC`, never `HIT`.

## 7. WAF and rate limiting

**Security → WAF → Managed rules:** deploy the Cloudflare Managed Ruleset (on Pro and above; the Free plan gets the Free Managed Ruleset automatically). Start in the default action and watch **Security → Events** for a week. A false positive on a legitimate form post shows up there, with the rule ID to except.

**Rate limiting rules.** Server Actions are `POST` requests to the page's own URL that carry a `Next-Action` header, so the rules key on method and path, counted per IP. Starting values (adjust them after watching Events):

| Rule | Expression | Limit |
|---|---|---|
| Auth forms | `http.request.method eq "POST" and http.request.uri.path in {"/login" "/signup" "/magic-link" "/set-password"}` | 10 per minute per IP, block 10 minutes |
| Step-up and other Server Action posts | `http.request.method eq "POST" and any(lower(http.request.headers.names[*])[*] eq "next-action")` | 120 per minute per IP, block 1 minute (step-up renders on many pages, so this is a generous app-wide cap) |
| Card payment start | `http.request.method eq "POST" and starts_with(http.request.uri.path, "/pay/") and ends_with(http.request.uri.path, "/start")` | 10 per minute per IP |
| Auth callback | `http.request.uri.path eq "/auth/callback"` | 20 per minute per IP |

The number of rules, the counting periods, the characteristics and the fields an expression may use (headers in particular) all depend on the Cloudflare plan. The Free plan allows one rule with a 10-second period. On Free, that one rule is the auth-forms rule, scaled to the period (for example 3 per 10 seconds).

**Machine callers: never challenge them.** These are called by servers, not browsers, and cannot solve a challenge:
- `/api/stripe/webhook`: Stripe.
- `/api/exports/run`, `/api/erasure/run`, `/api/retention/run`, `/api/incident-alerts/deliver`: Supabase `pg_net`, with a bearer secret.

Add a **WAF custom rule** with action **Skip** for `http.request.uri.path in {"/api/stripe/webhook" "/api/exports/run" "/api/erasure/run" "/api/retention/run" "/api/incident-alerts/deliver"}`. Have it skip the managed rules' challenge actions, Super Bot Fight Mode and the rate-limiting rules above. Each route authenticates its own caller: Stripe's signature, or the runner's bearer secret.

**Do not turn on (free) Bot Fight Mode.** WAF rules cannot skip it, so it would challenge Stripe and `pg_net`. It also sets `__cf_bm` on every visitor. Turnstile already covers the auth forms. On Pro and above, Super Bot Fight Mode *can* be skipped by the rule above. If it is enabled, set "definitely automated" to Block or Managed Challenge, and confirm the skip first.

**Verify:**
- Managed rules: Security → Events shows the ruleset evaluating traffic.
- A rate limit, without load: set the auth-forms rule's action to **Log** first. Submit `/login` with a wrong password eleven times by hand within a minute, and confirm Events logs the rule on the eleventh. Then switch it to Block.
- Machine callers: Stripe dashboard → the webhook endpoint → **Send test event** → a 2xx response. For the runners, after the next `pg_cron` tick: `select status_code, created from net._http_response order by created desc limit 10;` shows 200s, not 403 or 503.

## 8. Client IP and per-IP limits

The application reads **no** client IP. Nothing in `app/`, `lib/` or `components/` reads `x-forwarded-for`, `cf-connecting-ip` or `x-real-ip`, so the proxy changes no application decision. Behind the proxy the origin sees Cloudflare's addresses. If the reverse proxy's access logs need real visitor IPs, configure its real-IP module to trust `CF-Connecting-IP` **only** from Cloudflare's ranges (§ 4).

GoTrue's own per-IP limits (`[auth.rate_limit] sign_in_sign_ups`, `token_verifications`) see the **app server's** IP for every sign-in, sign-up and magic link made through the app, because those calls run server-side. They cannot tell one visitor from another. So:
- **the edge rate limits in § 7** bound attempts per visitor through the app; and
- **Turnstile** (§ 1) bounds the calls that skip the app and go straight to GoTrue. Without a token, GoTrue refuses those calls before it reads the address. That protects the project-wide auth email budget and the password grant (`SECURITY.md` § 10).

The app's per-account password budget (`lib/auth/login-budget.ts`) still applies to every password attempt made through the app.

## 9. When something breaks

- **Every sign-in says "The security check didn't complete":** the GoTrue secret does not belong to the site key's widget, the domain is not in the widget's hostnames, or the site key was set without a rebuild. To restore sign-in while you fix it, disable CAPTCHA protection in the Supabase dashboard; the widget is harmless on its own.
- **A blank page or console CSP errors after enabling the proxy:** Rocket Loader, Email Obfuscation or another HTML-rewriting feature is on (§ 6).
- **Stripe or the runners fail after enabling the proxy:** check Security → Events for the path, and the skip rule (§ 7).
