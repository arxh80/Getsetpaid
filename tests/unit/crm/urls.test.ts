import { describe, expect, it } from "vitest";

// URL protocol validation, both directions.
//
// CLAUDE.md § Non-negotiable rules requires `javascript:` and `data:` to be
// rejected. The half that matters most is the RENDER side: rows predating this
// code exist by assumption, PostgREST is reachable from a browser with the
// anon key, and Task 6's merge and any import write these columns by paths
// that have not been built yet. So the stored-bad-value-on-the-way-OUT case is
// tested first and hardest.

const { safeHref, hasUnsafeScheme, normaliseWebsite, parseSocials, mergeSocials } =
  await import("@/lib/crm/urls");

// The evasions, written with escapes rather than literal control characters --
// see stripUrlNoise()'s comment for why (a raw NUL byte in a test file made
// Task 3's cursor test invisible to git).
const NUL = "\u0000";
const TAB = "\u0009";
const LF = "\u000a";
const CR = "\u000d";

describe("safeHref: a stored bad value renders inert", () => {
  const hostile = [
    ["plain", "javascript:alert(1)"],
    ["case", "JaVaScRiPt:alert(1)"],
    ["leading whitespace", "   javascript:alert(1)"],
    ["leading NUL", `${NUL}javascript:alert(1)`],
    ["TAB inside the scheme", `java${TAB}script:alert(1)`],
    ["LF inside the scheme", `java${LF}script:alert(1)`],
    ["CR inside the scheme", `java${CR}script:alert(1)`],
    ["data url", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["data, uppercase", "DATA:text/html,<script>alert(1)</script>"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["file", "file:///etc/passwd"],
    ["blob", "blob:https://example.com/1234"],
    ["about", "about:blank"],
  ] as const;

  for (const [label, value] of hostile) {
    it(`returns null for ${label}`, () => {
      expect(safeHref(value)).toBeNull();
    });
  }

  it("returns null for a bare handle, which is the ORDINARY case", () => {
    // Not a failure. A social field holds handles far more often than URLs,
    // and the page shows the handle as text.
    expect(safeHref("@nightshift")).toBeNull();
    expect(safeHref("nightshift")).toBeNull();
  });

  it("does NOT guess at a bare host", () => {
    // Deliberate. Upgrading `instagram.com/x` to https on RENDER would be
    // guessing that a stored string is a link, and a wrong guess on the way
    // out is a link to somewhere the record does not name. The write path
    // upgrades a `website` value once, where the user can see what it became.
    expect(safeHref("instagram.com/nightshift")).toBeNull();
  });

  it("returns the PARSER'S normalised href for a safe URL, not the input", () => {
    // What reaches the DOM is `new URL()`'s output, so a string that parses to
    // something other than what it looks like cannot arrive intact.
    expect(safeHref("https://example.com")).toBe("https://example.com/");
    expect(safeHref("HTTP://Example.COM/Path")).toBe("http://example.com/Path");
  });

  it("handles a non-string and an empty value without throwing", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});

describe("hasUnsafeScheme: the write-side guard", () => {
  it("refuses a value that announces a scheme we will not render", () => {
    expect(hasUnsafeScheme("javascript:alert(1)")).toBe(true);
    expect(hasUnsafeScheme(`java${TAB}script:alert(1)`)).toBe(true);
    expect(hasUnsafeScheme("data:text/html,x")).toBe(true);
    expect(hasUnsafeScheme("mailto:a@b.com")).toBe(true);
  });

  it("accepts a handle, which announces nothing", () => {
    // Deliberately NARROWER than "safeHref returns null". Refusing everything
    // that will not linkify would refuse most real social input.
    expect(hasUnsafeScheme("@nightshift")).toBe(false);
    expect(hasUnsafeScheme("nightshift")).toBe(false);
    expect(hasUnsafeScheme("instagram.com/nightshift")).toBe(false);
    expect(hasUnsafeScheme("")).toBe(false);
  });

  it("accepts http and https", () => {
    expect(hasUnsafeScheme("https://example.com")).toBe(false);
    expect(hasUnsafeScheme("http://example.com")).toBe(false);
  });
});

describe("normaliseWebsite", () => {
  it("upgrades a bare host, because that is what people type", () => {
    expect(normaliseWebsite("getsetpaid.com")).toEqual({
      ok: true,
      value: "https://getsetpaid.com/",
    });
    expect(normaliseWebsite("www.example.co.uk/about")).toEqual({
      ok: true,
      value: "https://www.example.co.uk/about",
    });
  });

  it("keeps an explicit scheme", () => {
    expect(normaliseWebsite("http://example.com/x")).toEqual({
      ok: true,
      value: "http://example.com/x",
    });
  });

  it("refuses a hostile scheme rather than storing it", () => {
    const result = normaliseWebsite("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("refuses a hostile scheme hidden behind whitespace and controls", () => {
    expect(normaliseWebsite(`  java${TAB}script:alert(1)`).ok).toBe(false);
    expect(normaliseWebsite(`${NUL}data:text/html,x`).ok).toBe(false);
  });

  it("treats empty and null as no website, not as an error", () => {
    expect(normaliseWebsite(null)).toEqual({ ok: true, value: null });
    expect(normaliseWebsite("   ")).toEqual({ ok: true, value: null });
  });

  it("refuses something that is not a web address at all", () => {
    expect(normaliseWebsite("not a website").ok).toBe(false);
  });

  it("caps the length", () => {
    expect(normaliseWebsite(`https://e.com/${"a".repeat(3000)}`).ok).toBe(false);
  });
});

describe("parseSocials", () => {
  it("computes href once, so no page can render a bad value into an anchor", () => {
    const entries = parseSocials({
      instagram: "@nightshift",
      soundcloud: "https://soundcloud.com/nightshift",
      x: "javascript:alert(1)",
    });
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.instagram.href).toBeNull();
    expect(byKey.soundcloud.href).toBe("https://soundcloud.com/nightshift");
    // THE STORED-BAD-VALUE CASE. The value is still shown -- hiding it would
    // make it unfixable through the product -- but it is not a link.
    expect(byKey.x.href).toBeNull();
    expect(byKey.x.value).toBe("javascript:alert(1)");
  });

  it("keeps a key the form does not offer, rather than dropping the user's data", () => {
    const entries = parseSocials({ mixcloud: "@nightshift" });
    expect(entries).toHaveLength(1);
    // No label in the fixed list, so the key itself is the label.
    expect(entries[0]!.label).toBe("mixcloud");
  });

  it("survives every shape the column's only CHECK permits", () => {
    // `jsonb_typeof(socials) = 'object'` is the whole constraint, so a value
    // inside it can be a number, an array, a nested object or null. Any of
    // those reaching String() renders "[object Object]" in a table cell.
    expect(parseSocials({ a: 1, b: null, c: [], d: { e: "f" }, g: "  " })).toEqual([]);
  });

  it("survives a value that is not an object at all", () => {
    // Not reachable through the CHECK, and reachable through a row written
    // before it existed or by a future migration that relaxes it.
    expect(parseSocials(null)).toEqual([]);
    expect(parseSocials("string")).toEqual([]);
    expect(parseSocials([1, 2])).toEqual([]);
    expect(parseSocials(undefined)).toEqual([]);
  });
});

describe("mergeSocials: an edit must not destroy a key the form never showed", () => {
  // I-1. `parseSocials` preserved unknown keys on READ and the comment on
  // SOCIAL_PLATFORMS said so; the write path then built a fresh object from
  // the six form keys and wrote it over the column. Reproduced in a browser
  // against a planted row: editing `instagram` deleted `mixcloud`, silently,
  // with no undo and no audit row.

  it("keeps a stored key the form has no input for", () => {
    // The exact fixture from the review: an imported row, one field edited.
    expect(
      mergeSocials(
        { mixcloud: "https://mixcloud.com/keepme", instagram: "@old" },
        { instagram: "@ok" },
      ),
    ).toEqual({ mixcloud: "https://mixcloud.com/keepme", instagram: "@ok" });
  });

  it("CLEARS a known platform the user emptied, rather than reverting it", () => {
    // The other half, and the one a naive `{ ...stored, ...submitted }` gets
    // wrong: an emptied input submits nothing, so the key is absent from the
    // submission -- and absent must mean cleared for the six the form owns.
    expect(mergeSocials({ instagram: "@old", mixcloud: "@keep" }, {})).toEqual({
      mixcloud: "@keep",
    });
  });

  it("adds a platform that was not stored before", () => {
    expect(mergeSocials({}, { x: "@new" })).toEqual({ x: "@new" });
  });

  it("takes an empty stored column, a null one, and a malformed one", () => {
    // `jsonb_typeof(socials) = 'object'` is the whole constraint, and rows
    // predating it exist by assumption.
    expect(mergeSocials(null, { x: "@a" })).toEqual({ x: "@a" });
    expect(mergeSocials(undefined, { x: "@a" })).toEqual({ x: "@a" });
    expect(mergeSocials("not an object", { x: "@a" })).toEqual({ x: "@a" });
    expect(mergeSocials([1, 2], { x: "@a" })).toEqual({ x: "@a" });
  });

  it("does not carry a stored NON-STRING through into the column", () => {
    // Same rule parseSocials applies on the way out: a number or a nested
    // object is not a handle. Carrying it would re-store a value no screen can
    // render.
    expect(mergeSocials({ a: 1, b: null, c: [], keep: "@k" }, {})).toEqual({
      keep: "@k",
    });
  });
});
