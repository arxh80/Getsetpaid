# Deploying GetSetPaid

GetSetPaid runs on the IONOS VPS it shares with Tesselo (`ssh tesselo`, Ubuntu, 2 vCPU, 1.8 GB). The database, auth and storage are the hosted Supabase project in eu-west-1. Only the Next.js server runs on the VPS.

```
visitor → Cloudflare (WAF, Turnstile)
        → VPS :443, Tesselo's Caddy (mTLS: Cloudflare's origin-pull cert only;
          password gate until launch)
        → getsetpaid-app:3000 on the `edge` Docker network
        → Supabase (eu-west-1)
```

## 1. What lives where

| Thing | Where | Who sets it |
|---|---|---|
| Image | Built in GitHub Actions (`.github/workflows/deploy.yml`), streamed over SSH, never in a registry | the workflow |
| `compose.yml`, `receive.sh` | `~/getsetpaid/` on the VPS, copied from `deploy/` | one-time setup, § 3 |
| Runtime secrets | `~/getsetpaid/.env.production` on the VPS, mode 600; never in git or Actions | § 4 |
| Public build values | GitHub repo variables `NEXT_PUBLIC_*`, `DEPLOY_HOST` | § 4 |
| Deploy key | GitHub secret `DEPLOY_SSH_KEY`; the public half in `~deploy/.ssh/authorized_keys` forced to `receive.sh` | § 3 |
| Host key pin | GitHub secret `DEPLOY_KNOWN_HOSTS` | § 3 |
| Origin cert and key, origin-pull CA, `gate.caddy` | `~/getsetpaid/tls/`, mounted read-only into Caddy | § 2 |
| Caddy site | `deploy/getsetpaid.caddy` → `~/Tesselo/sites/getsetpaid.caddy`, imported by Tesselo's Caddyfile | § 3 |

## 2. Cloudflare (zone `getsetpaid.com`)

1. **DNS:** `A getsetpaid.com` and `A www` → the VPS IP, **Proxied**. Brevo's records stay DNS-only (`docs/email-setup.md`).
2. **SSL/TLS:** mode **Full (strict)**, minimum TLS 1.2, Always Use HTTPS on. Create an **Origin CA certificate** for `getsetpaid.com, *.getsetpaid.com` and put it in `~/getsetpaid/tls/origin.pem` and `origin.key` (mode 600).
3. **Authenticated Origin Pulls:** turn on zone-level origin pulls, and put Cloudflare's origin-pull CA in `~/getsetpaid/tls/cloudflare-origin-pull-ca.pem`. Caddy then refuses any TLS handshake that does not present Cloudflare's client certificate. This is the origin lock. A firewall limited to Cloudflare's ranges would cut off Tesselo, which is served direct.
4. **Until launch, a password gate** on the Caddy site (`~/getsetpaid/tls/gate.caddy`, imported by `deploy/getsetpaid.caddy`): HTTP basic auth on every path except these machine paths, each of which authenticates itself:
   - `/api/stripe/webhook` (Stripe's signature)
   - `/api/exports/run`, `/api/erasure/run`, `/api/retention/run`, `/api/incident-alerts/deliver` (the runner secrets; called by `pg_net` from Supabase)

   The password is in `~/.config/getsetpaid/site-gate-password` on the founder's machine; only its bcrypt hash is on the VPS. Cloudflare Access would do the same at the edge but needs Zero Trust enabled on the account (a plan and terms the founder accepts). At launch, replace `gate.caddy` with one comment line and reload Caddy.
5. **Turnstile:** follow `docs/runbooks/cloudflare.md` § 1, and its §§ 3-8 for the WAF, rate limits and the settings to keep off.

## 3. One-time VPS setup

1. `docker network create edge`. Tesselo's compose puts Caddy on `edge` too, and mounts `~/getsetpaid/tls` and `~/Tesselo/sites`.
2. Copy `deploy/compose.yml` and `deploy/receive.sh` to `~/getsetpaid/` (`chmod 700 receive.sh`).
3. Generate a deploy key pair that is used for nothing else. Append its public half to `~deploy/.ssh/authorized_keys` as:
   `command="/home/deploy/getsetpaid/receive.sh",restrict ssh-ed25519 AAAA... getsetpaid-deploy`
   Store the private half as the `DEPLOY_SSH_KEY` secret, and `ssh-keyscan` of the VPS as `DEPLOY_KNOWN_HOSTS`.
4. Copy `deploy/getsetpaid.caddy` to `~/Tesselo/sites/`, then recreate only Caddy:
   `cd ~/Tesselo && docker compose --env-file .env.production --profile prod up -d caddy`.
   Afterwards check that Tesselo still answers.

## 4. Configuration

**GitHub repo variables** (all public by design): `NEXT_PUBLIC_SITE_URL=https://getsetpaid.com`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `DEPLOY_HOST`.

**`~/getsetpaid/.env.production`** (mode 600). Every value is server-only:

| Variable | Source |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase API keys |
| `GETSETPAID_SERVER_REQUEST_SECRET` | `openssl rand -hex 32`. Its SHA-256 goes in Vault as `server_request_mark_digest` (`SECURITY.md` § 15) |
| `EXPORT_RUNNER_SECRET`, `ERASURE_RUNNER_SECRET`, `RETENTION_RUNNER_SECRET`, `INCIDENT_ALERT_DELIVERY_SECRET` | `openssl rand -hex 32` each, all different. Each one, with its runner URL on `https://getsetpaid.com`, is also stored in Vault (`SECURITY.md` § 15) |
| `INVOICE_PAY_LINK_SECRET` | `openssl rand -hex 32` |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, `SUPPORT_CONTACT_EMAIL` | Brevo, after domain authentication (`docs/email-setup.md`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | the alerts bot |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` | Stripe (launch-gates F13). While these are unset, card payment is off |

`MALWARE_SCANNER=structural` is set in `compose.yml` (Q286), not here.

**Supabase (hosted):** Site URL `https://getsetpaid.com`, and redirect URLs on that domain only, with no localhost entries. Turn on CAPTCHA with the Turnstile secret at the same moment the site key is built in. The full list is in `SECURITY.md` § 15.

## 5. Deploy and roll back

- **Deploy:** GitHub → Actions → `deploy` → Run workflow (main only). The VPS loads the image and starts it. If it is not healthy within 120 s, the VPS rolls back to the previous image.
- **Roll back by hand:** `ssh -i <deploy key> deploy@<host> rollback`.
- **Logs:** `ssh tesselo 'docker logs --tail 200 getsetpaid-app'`.

## 6. Locked down: check before taking the gate off

- [ ] `curl -sk --resolve getsetpaid.com:443:<VPS IP> https://getsetpaid.com/login` fails the handshake (origin lock).
- [ ] Without the password, `https://getsetpaid.com/login` answers 401, and `/api/stripe/webhook` still reaches the app.
- [ ] `docker inspect getsetpaid-app` shows a read-only root filesystem, `CapDrop: [ALL]`, user 1001, and no host port.
- [ ] `stat -c %a ~/getsetpaid/.env.production ~/getsetpaid/tls/*.key` prints `600`.
- [ ] Every item in `SECURITY.md` § 15 and `docs/launch-gates.md` is done or signed off.
