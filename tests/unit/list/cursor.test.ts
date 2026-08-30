import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/lib/list/cursor";

// Cursor encoding. The second of the two places in the list surface where a
// bug is a security bug rather than a display bug: the `id` half of a cursor
// is interpolated into a PostgREST logic tree, so the uuid check here is what
// guarantees that half can carry no grammar characters whatever arrives.

const NIL = "00000000-0000-0000-0000-000000000000";
const SORT = "name";

describe("round trip", () => {
  it.each([
    ["a plain name", "Ada Ali"],
    ["an empty value", ""],
    ["a comma", "O'Brien, Sean"],
    ["a double quote", 'Quote" Name'],
    ["a backslash", "Back\\slash Name"],
    ["a close paren", "Paren) Name"],
    ["PostgREST operator syntax", "name.eq.evil"],
    ["a whole filter expression", '"),id.gt.0,and(x.eq.1'],
    ["an ISO timestamp", "2026-08-28T09:14:22.123456+00:00"],
    ["unicode", "Bjørk Guðmundsdóttir 東京"],
    ["an emoji", "Ada 🎧 Ali"],
    ["a newline", "Ada\nAli"],
    ["a null byte", "Ada\u0000Ali"],
    ["a lone surrogate-ish sequence", "Ada�Ali"],
    ["leading and trailing spaces", "  padded  "],
  ])("survives %s", (_label, value) => {
    expect(decodeCursor(encodeCursor({ value, id: NIL, sort: SORT }))).toEqual({
      value,
      id: NIL,
      sort: SORT,
    });
  });

  it("produces a URL-safe token needing no further encoding", () => {
    const encoded = encodeCursor({
      value: 'a+b/c=d?e&f#g "h" \\i',
      id: NIL,
      sort: SORT,
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});

describe("decodeCursor never throws and never guesses", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["not base64", "!!!!!!"],
    ["base64 of not-JSON", Buffer.from("hello").toString("base64url")],
    ["base64 of an object", Buffer.from('{"a":1}').toString("base64url")],
    ["base64 of a bare string", Buffer.from('"x"').toString("base64url")],
    ["base64 of null", Buffer.from("null").toString("base64url")],
    ["base64 of a number", Buffer.from("42").toString("base64url")],
    ["an empty array", Buffer.from("[]").toString("base64url")],
    ["a one-element array", Buffer.from('["a"]').toString("base64url")],
    [
      "a four-element array",
      Buffer.from('["a","' + NIL + '","name","x"]').toString("base64url"),
    ],
    [
      // The pre-fix-round-1 format. Refused rather than defaulted: a
      // two-element cursor cannot say which column its value came from, so
      // assuming a sort for it would reinstate exactly the defect the third
      // element closes (review I-2).
      "the old two-element format",
      Buffer.from('["a","' + NIL + '"]').toString("base64url"),
    ],
    [
      "a non-string value",
      Buffer.from('[1,"' + NIL + '","name"]').toString("base64url"),
    ],
    [
      "a null value",
      Buffer.from('[null,"' + NIL + '","name"]').toString("base64url"),
    ],
    [
      "a nested object as the value",
      Buffer.from('[{"a":1},"' + NIL + '","name"]').toString("base64url"),
    ],
    [
      "a non-string sort key",
      Buffer.from('["a","' + NIL + '",7]').toString("base64url"),
    ],
    [
      "an empty sort key",
      Buffer.from('["a","' + NIL + '",""]').toString("base64url"),
    ],
    [
      "an over-long sort key",
      Buffer.from('["a","' + NIL + '","' + "s".repeat(65) + '"]').toString("base64url"),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(decodeCursor(raw as string | null | undefined)).toBeNull();
  });

  // THE UUID CHECK IS THE ONE THAT MATTERS. `id` goes into
  //   and(name.eq."...",id.gt.<id>)
  // unquoted, because a uuid has no PostgREST grammar characters in it. That
  // is only true if it really is a uuid, so every one of these has to be
  // refused -- each is a payload that would otherwise reach the logic tree.
  it.each([
    "not-a-uuid",
    "0",
    "",
    "11111111-1111-1111-1111-11111111111", // one short
    "11111111-1111-1111-1111-1111111111111", // one long
    "11111111111111111111111111111111", // unhyphenated
    "1111111g-1111-1111-1111-111111111111", // non-hex
    `${NIL},id.gt.${NIL}`, // a comma, to close the and()
    `${NIL})`, // a paren, to close the or()
    `${NIL} or 1=1`,
    `${NIL}\n`,
    ` ${NIL}`,
    `${NIL} `,
    `"${NIL}"`,
  ])("rejects the id %j", (id) => {
    const raw = Buffer.from(JSON.stringify(["Ada", id, SORT])).toString(
      "base64url",
    );
    expect(decodeCursor(raw)).toBeNull();
  });

  it("accepts an upper-case uuid, which Postgres also accepts", () => {
    const upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const raw = Buffer.from(JSON.stringify(["Ada", upper, SORT])).toString(
      "base64url",
    );
    expect(decodeCursor(raw)?.id).toBe(upper);
  });
});

describe("the sort key the cursor was made under", () => {
  // Review I-2. Without this field a cursor is just a string and the caller
  // cannot know whether it is a name or a timestamp; `?sort=updated` with a
  // name cursor produced `updated_at >= 'Contact 00100'`, a PostgREST 400 and
  // a page that told the user the system was broken.
  it("round-trips", () => {
    for (const sort of ["name", "updated", "a", "s".repeat(64)]) {
      expect(
        decodeCursor(encodeCursor({ value: "Ada", id: NIL, sort }))?.sort,
      ).toBe(sort);
    }
  });

  it("is part of what makes two cursors different", () => {
    const a = encodeCursor({ value: "Ada", id: NIL, sort: "name" });
    const b = encodeCursor({ value: "Ada", id: NIL, sort: "updated" });
    expect(a).not.toBe(b);
    expect(decodeCursor(a)?.sort).toBe("name");
    expect(decodeCursor(b)?.sort).toBe("updated");
  });
});

describe("bounds", () => {
  it("refuses an over-long encoded cursor without decoding it", () => {
    expect(decodeCursor("A".repeat(2000))).toBeNull();
  });

  it("refuses an over-long sort value", () => {
    const raw = Buffer.from(
      JSON.stringify(["x".repeat(513), NIL, SORT]),
    ).toString("base64url");
    expect(decodeCursor(raw)).toBeNull();
  });

  it("accepts a sort value at the limit", () => {
    const value = "x".repeat(512);
    expect(decodeCursor(encodeCursor({ value, id: NIL, sort: SORT }))?.value).toBe(
      value,
    );
  });
});
