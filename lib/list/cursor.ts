// Keyset cursor encoding.
//
// A cursor names the row a page starts after (or ends before): the value of
// the sort column and the row's id. It is NOT a capability -- RLS decides
// which rows exist for this caller and the tenant filter is written into the
// query separately, so a forged cursor can at worst select the wrong page of
// rows the caller may already read. It is still validated strictly, for two
// reasons that are not about authorisation:
//
//   1. `id` is interpolated into a PostgREST logic tree. Pinning it to the
//      uuid shape means that half of the filter can carry no grammar
//      characters at all, whatever arrives. The other half (the sort value)
//      is free text by nature and is handled by quoting -- see
//      lib/list/postgrest.ts.
//   2. A cursor that does not decode must produce the FIRST page, never an
//      exception. A link pasted into Slack after a redeploy, a truncated URL,
//      a bookmark from before a sort was renamed: all of those are ordinary,
//      and a 500 for any of them is a worse bug than the wrong page.

/** Base64url payload sizes above this are refused without decoding. */
const MAX_ENCODED_LENGTH = 1024;

/** Sort values longer than this are refused. `contacts.name` has no length cap. */
const MAX_VALUE_LENGTH = 512;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Cursor {
  /** The sort column's value on the boundary row, as a string. */
  readonly value: string;
  /** The boundary row's primary key. */
  readonly id: string;
  /**
   * WHICH SORT THE VALUE CAME FROM. Not decoration -- without it a cursor is
   * just a string, and the caller has no way to know whether that string is a
   * name or a timestamp.
   *
   * Found in review: `?sort=updated` with a cursor made under `sort=name`
   * produced `updated_at >= 'Contact 00100'`, PostgREST answered 400, and the
   * page rendered "We couldn't load contacts just now" -- telling the user the
   * system is broken when in fact the URL is stale. `buildListHref` drops the
   * cursor on a sort change, so in-app navigation cannot produce it; the only
   * thing between that error and a user is a link that outlives one
   * `buildListHref` call. A bookmark. A Slack paste. This file's own header
   * names "a bookmark from before a sort was renamed" as an ordinary case it
   * intends to answer with page one, and before this field it did not.
   *
   * `parseListParams` discards a cursor whose sort does not match the request's,
   * so the stale link degrades to page one instead of to an error.
   */
  readonly sort: string;
}

/** Sort keys longer than this are refused. Real keys are one short word. */
const MAX_SORT_LENGTH = 64;

/** Which side of the cursor the page lies on. */
export type CursorDirection = "after" | "before";

export function encodeCursor(cursor: Cursor): string {
  // An array rather than an object: shorter in the URL, and it has no key
  // names for a reader to mistake for something meaningful. The cursor is
  // opaque by intent -- it encodes a position, not a promise about shape.
  return Buffer.from(
    JSON.stringify([cursor.value, cursor.id, cursor.sort]),
  ).toString("base64url");
}

/**
 * Decode a cursor, or null if it is not one.
 *
 * Never throws. Every rejection path returns null and the caller renders the
 * first page.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > MAX_ENCODED_LENGTH) return null;

  let parsed: unknown;
  try {
    // Node's base64url decoder is lenient: it ignores characters outside the
    // alphabet rather than failing, so garbage decodes to garbage instead of
    // throwing. That is fine -- the JSON.parse below is what actually rejects
    // it -- but it means the length and shape checks here are the real gate,
    // not the decode.
    const json = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Exactly three elements. A two-element array is the OLD format, and it is
  // refused rather than defaulted: a pre-sort-key cursor cannot say which
  // column it came from, so accepting one with an assumed sort would reinstate
  // the defect the third element exists to close. Refusing gives page one,
  // which is what every other unreadable cursor gives.
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [value, id, sort] = parsed as [unknown, unknown, unknown];

  if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof sort !== "string" || sort.length === 0) return null;
  if (sort.length > MAX_SORT_LENGTH) return null;

  return { value, id, sort };
}
