// The opaque, tenant-scoped storage key for a document's bytes.
//
// ===========================================================================
// THE KEY CARRIES NO USER INPUT. THAT IS THE WHOLE JOB.
// ===========================================================================
// CLAUDE.md § Non-negotiable rules: "sanitised filenames (never user-supplied
// paths as storage keys)". A storage key that contained any part of the
// uploaded filename would be a path-traversal surface (`../../other-org/x`)
// AND a cross-tenant surface. So the key is built from exactly two ids the
// SERVER chose -- the organisation id (from getCurrentOrg, never the request
// body) and a freshly minted document id (crypto.randomUUID) -- and nothing
// the user typed ever reaches it. The sanitised filename is a DISPLAY string
// stored in documents.filename; it is not this.
//
// `${orgId}/${documentId}` also satisfies the database's
// `documents_storage_key_shape` CHECK (20260902001000) by construction: the
// key MUST begin with the row's own organisation id followed by a slash, so
// even a bug here that produced another org's prefix is a 23514 rather than a
// cross-tenant file. Two layers, and this module is the first.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The storage key for a document: `{organisationId}/{documentId}`.
 *
 * Both arguments MUST be uuids the server chose -- this throws on anything
 * else, so a caller that ever tried to route a client string through here
 * fails loudly at the seam rather than writing a malformed or traversing key.
 * The upload action passes `org.id` and a `crypto.randomUUID()`, so in normal
 * operation the guard never fires; it exists so the "no user input" property
 * is enforced by the function and not merely by its call sites.
 */
export function buildStorageKey(organisationId: string, documentId: string): string {
  if (!UUID_RE.test(organisationId)) {
    throw new Error("buildStorageKey: organisationId is not a uuid");
  }
  if (!UUID_RE.test(documentId)) {
    throw new Error("buildStorageKey: documentId is not a uuid");
  }
  return `${organisationId}/${documentId}`;
}
