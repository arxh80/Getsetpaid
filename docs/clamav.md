# ClamAV upload scanning

Founder decision Q42 (2026-10-13): every upload is scanned by a **self-hosted
ClamAV** daemon. It is free, open source, and runs on our own server, so no
customer file ever leaves the UK/EU region. Free SaaS tiers were rejected:
VirusTotal's free API forbids commercial use and shares every submission with
third parties, and the other free tiers are US-hosted or capped at a few
hundred scans a month.

## How it fits

```
upload action ──sniff/allowlist──▶ storage (pending) ──zINSTREAM──▶ clamd
                                                   ◀── "stream: OK" / "… FOUND"
```

`lib/security/malware-scan.ts` → `ClamdScanner` streams the bytes to clamd over
TCP (INSTREAM, 64 KiB chunks, nothing written to disk) and maps the reply:

| clamd reply | verdict | `scan_status` | downloadable |
|---|---|---|---|
| `stream: OK` | `clean` | `clean` | yes |
| `stream: <signature> FOUND` | `infected` | `quarantined` | no (409) |
| anything else — refused, timeout, `… ERROR`, empty | throws | `error` | no (409) |

The last row is the point: **a broken or missing scanner can never pass a
file.** Both upload actions (`lib/crm/documents.ts`,
`lib/feedback/actions.ts`) turn a throw into `error`.

## Configuration

| Variable | Value | Default |
|---|---|---|
| `MALWARE_SCANNER` | `clamav` in every deployed environment | dev/test: `stub` (EICAR-only); `NODE_ENV=production`: every scan fails closed |
| `CLAMAV_HOST` | the clamd host | — (required; missing ⇒ every scan fails closed) |
| `CLAMAV_PORT` | clamd TCP port | `3310` |
| `CLAMAV_TIMEOUT_MS` | whole-scan deadline | `30000` |

A malformed port/timeout, a missing host or a misspelt provider name all
resolve to a scanner that throws — never silently to the stub.

## Running it

**Locally:** ⚠️ not on the current dev machine. Its `.wslconfig` caps the
Docker VM at 2 GB, and clamd (~1.5 GB) beside the local Supabase stack ran the
VM out of memory and hung Docker on 2026-10-13 (recovered with
`wsl --shutdown`). Run it only on a machine whose Docker VM has ≥ 4 GB free.

```sh
docker compose -f docker/clamav/compose.yml -p gsp-clamav up -d
# first start downloads ~300 MB of signatures; wait until healthy:
docker inspect -f '{{.State.Health.Status}}' gsp-clamav-clamav-1
```

Then set `MALWARE_SCANNER=clamav` and `CLAMAV_HOST=127.0.0.1` in `.env.local`.
Stop it with `docker compose -f docker/clamav/compose.yml -p gsp-clamav down`
(add `-v` to delete the downloaded signatures).

**Live test** — the same client against the real engine (EICAR plain, EICAR
inside a compressed zip, a clean 25 MiB file, EICAR at the end of a 25 MiB
file):

```sh
CLAMAV_LIVE_HOST=127.0.0.1 npx vitest run tests/integration/security/clamav-live.test.ts
```

It is skipped when `CLAMAV_LIVE_HOST` is unset, so `pnpm test` does not need
ClamAV.

**Production (IONOS, founder Q-hosting ruling):** run the same compose service
beside the app on the same server or private network.

- **Memory:** clamd holds the signature database in RAM — about 1.5 GB, and
  roughly double that for a few seconds while a signature update reloads.
  Budget **3 GB** for it (the compose file's `mem_limit`); size the server
  accordingly.
- **Never expose port 3310.** clamd has no authentication. The compose file
  publishes it on `127.0.0.1` only; keep it that way, or put clamd on a private
  Docker network with the app and publish nothing.
- **Signatures** update automatically: the image's bundled `freshclam` checks
  every 2 hours. The `clamav-db` volume keeps them across restarts.
- **Monitoring:** the health check fails if clamd stops answering. An upload
  made while it is down lands as `error` (not downloadable), and the user sees
  the normal scan-failed state — nothing is lost, but nothing is cleared
  either, so alert on an unhealthy container.

## What `clamd.conf` changes, and why

clamd's defaults cap a scanned file at 25 MB and **report anything bigger as
clean, unscanned**. Our uploads go up to 25 MiB, so the shipped config raises
`StreamMaxLength`/`MaxFileSize` to 30M and `MaxScanSize` to 200M (an inflated
docx can be much larger than the upload). It also sets:

- `AlertExceedsMax yes` — a file that hits any scan limit (zip bomb, deep
  nesting) is reported FOUND and quarantined instead of passing half-scanned.
- `AlertEncryptedArchive yes` — an archive clamd cannot open is not passed.
- `AlertOLE2Macros yes`, `AlertBrokenExecutables yes` — second layer behind
  the allowlist.

## What it does not do

- ClamAV catches less than commercial engines. It is a sound launch baseline,
  sitting behind the magic-byte allowlist that already refuses executables and
  macro-enabled Office files.
- Files are scanned once, at upload. A file that was clean under yesterday's
  signatures is not re-scanned when today's arrive.
