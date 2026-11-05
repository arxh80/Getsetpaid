// ===========================================================================
// THE STORAGE BACKUP JOB (Phase 10 Task 11, G30)
// ===========================================================================
// Supabase's database backups hold Storage METADATA only (storage.objects),
// never the files: contracts, riders and IDs in `documents`, feedback
// screenshots, and the workspace-closure backups in `exports`. This copies
// every object of the three private buckets to S3-compatible object storage
// under a dated prefix:  <BACKUP_S3_BUCKET>/<YYYY-MM-DD>/<bucket>/<path>.
//
//   node scripts/storage-backup.mjs
//
// Meant to run nightly on the host (founder action: schedule, destination
// bucket, its DPA and 30-day retention -- see docs/runbooks/backup-restore.md).
//
// SERVICE ROLE, on purpose and nowhere else: the buckets are fenced against
// every session (20260902030000), so only service_role can read them. This
// script builds its own client from SUPABASE_SERVICE_ROLE_KEY because
// lib/supabase/storage.ts is `server-only` and cannot load outside Next; it is
// not in the app bundle (scripts/ is excluded from the app source censuses,
// tests/unit/support/app-source.ts). It only LISTS and DOWNLOADS.
//
// No object is sent anywhere but BACKUP_S3_ENDPOINT, which must be https
// (http only for localhost). Uploads are signed with AWS Signature V4 here
// rather than through an SDK: one PUT does not justify the dependency.
// ===========================================================================
import { createHash, createHmac } from "node:crypto";

export const BUCKETS = ["documents", "feedback-screenshots", "exports"];
const PAGE = 100;

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_REGION",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
];

/** Validated settings, or a thrown Error naming what is missing or unsafe. */
export function configFromEnv(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`storage-backup: missing ${missing.join(", ")}; refusing to start`);
  const endpoint = new URL(env.BACKUP_S3_ENDPOINT);
  const local = ["localhost", "127.0.0.1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) {
    throw new Error("storage-backup: BACKUP_S3_ENDPOINT must be https");
  }
  return {
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    endpoint: endpoint.toString().replace(/\/$/, ""),
    bucket: env.BACKUP_S3_BUCKET,
    region: env.BACKUP_S3_REGION,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    prefix: env.BACKUP_PREFIX || new Date().toISOString().slice(0, 10),
  };
}

/** Every object path in a bucket: pages through each folder and recurses into subfolders. */
export async function listAll(source, bucket, folder = "") {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const entries = await source.list(bucket, folder, { limit: PAGE, offset });
    for (const e of entries) {
      const path = folder ? `${folder}/${e.name}` : e.name;
      // Storage's list() returns folders as entries with no id.
      if (e.id == null) out.push(...(await listAll(source, bucket, path)));
      else out.push(path);
    }
    if (entries.length < PAGE) return out;
  }
}

/** Copy every object of every bucket. Never throws on one object: failures are collected by name. */
export async function runBackup({ source, dest, buckets = BUCKETS, prefix }) {
  let copied = 0;
  const failed = [];
  for (const bucket of buckets) {
    for (const path of await listAll(source, bucket)) {
      try {
        const body = await source.download(bucket, path);
        await dest.put(`${prefix}/${bucket}/${path}`, body);
        copied += 1;
      } catch (e) {
        failed.push(`${bucket}/${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { copied, failed };
}

/** The source over a supabase-js client: list and download, nothing else. */
export function supabaseSource(client) {
  return {
    async list(bucket, folder, { limit, offset }) {
      const { data, error } = await client.storage.from(bucket).list(folder, { limit, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`list ${bucket}/${folder}: ${error.message}`);
      return data ?? [];
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error) throw new Error(error.message);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

/** An S3-compatible destination: one SigV4-signed path-style PUT per object, to the configured endpoint only. */
export function s3Destination({ endpoint, bucket, region, accessKeyId, secretAccessKey }, fetchImpl = fetch) {
  const base = new URL(endpoint);
  return {
    async put(key, body) {
      const url = new URL(`${base.pathname.replace(/\/$/, "")}/${bucket}/${encodeKey(key)}`, base);
      const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const day = now.slice(0, 8);
      const payloadHash = sha256(body);
      const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": now };
      const signed = Object.keys(headers).sort();
      const canonical = ["PUT", url.pathname, "", ...signed.map((h) => `${h}:${headers[h]}`), "", signed.join(";"), payloadHash].join("\n");
      const scope = `${day}/${region}/s3/aws4_request`;
      const toSign = ["AWS4-HMAC-SHA256", now, scope, sha256(canonical)].join("\n");
      const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
      const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
      const res = await fetchImpl(url, {
        method: "PUT",
        body,
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
        },
      });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
    },
  };
}

if (process.argv[1]?.endsWith("storage-backup.mjs")) {
  const { createClient } = await import("@supabase/supabase-js");
  let config;
  try {
    config = configFromEnv(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const started = Date.now();
  const { copied, failed } = await runBackup({
    source: supabaseSource(client),
    dest: s3Destination(config),
    prefix: config.prefix,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (failed.length > 0) {
    console.error(`storage-backup: ${failed.length} object(s) NOT copied (${copied} copied, ${secs}s):\n  ${failed.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`storage-backup: ${copied} object(s) copied to ${config.endpoint}/${config.bucket}/${config.prefix}/ in ${secs}s.`);
}
