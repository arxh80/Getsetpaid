import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ===========================================================================
// EVERY MIGRATION MUST BE VALID UTF-8. THE TWO TOOLS DISAGREE ABOUT WHAT
// HAPPENS WHEN ONE IS NOT, AND NEITHER ANSWER IS ACCEPTABLE.
// ===========================================================================
// Phase 7's pre-merge review (finding I3) found
// `20260918001000_health_shows_the_deferred_lockout_queue.sql` carrying two raw
// `0xA7` bytes (Latin-1 `§`) where every other `§` in the tree is the UTF-8
// pair `0xC2 0xA7` — the signature of an editor or PowerShell round-trip, i.e.
// the same "the body was rebuilt through the wrong channel" mechanism that
// twice dropped a clause in that phase. Both bytes sat INSIDE a `$$ … $$`
// function body, so they were part of the string the server parses.
//
// Measured on this stack, both ways:
//
//   * `npx supabase db reset --local` APPLIES the migration and SILENTLY
//     SUBSTITUTES U+FFFD REPLACEMENT CHARACTER. Confirmed by reading
//     `pg_proc.prosrc` back: a shipped security function's stored source is
//     mojibake, and every gate stays green.
//   * `psql -f` FAILS HARD:
//         ERROR:  invalid byte sequence for encoding "UTF8": 0xa7
//     so a restore, a CI job or a hosted SQL-editor paste aborts mid-tree and
//     leaves every later migration unapplied — in that case both of Q125's
//     grant-narrowing fixes.
//
// Tool-dependent, silent on the path everyone uses, and invisible to all five
// gates. So it is a gate now. The check is deliberately byte-level: reading
// with `encoding: "utf8"` would do exactly what the CLI does — substitute
// U+FFFD and report success.
//
// The same check runs over `supabase/tests/*.sql`, because those files are fed
// to `psql -f` by `run-rls-tests.sh`, which is the tool that fails HARD.
// ===========================================================================

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);
const PSQL_TESTS_DIR = fileURLToPath(
  new URL("../../../supabase/tests", import.meta.url),
);

function sqlFiles(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** `fatal: true` makes the decoder THROW on an invalid sequence instead of
 *  substituting U+FFFD — which is the entire point of this file. */
const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * THE ONE EXCEPTION, AND IT IS A LEDGER ENTRY RATHER THAN A SUPPRESSION.
 *
 * A committed migration is immutable in this repository, so the file that
 * carries the defect this gate exists to catch cannot be corrected in place.
 * It is listed here WITH THE MIGRATION THAT REPAIRS IT ADDITIVELY, and the
 * block below asserts three things about every entry: the named file really is
 * invalid (so a stale entry cannot sit here silently once someone does rewrite
 * history), the repairing migration exists and is itself clean, and the
 * repairing migration re-creates the object the corrupted body defined.
 *
 * Nothing may be added here to make a NEW migration pass. The whole point of
 * the check is that the fix is additive.
 */
const KNOWN_INVALID: Readonly<
  Record<string, { readonly repairedBy: string; readonly object: string }>
> = {
  "20260918001000_health_shows_the_deferred_lockout_queue.sql": {
    repairedBy: "20260921000000_health_snapshot_source_is_valid_utf8.sql",
    object: "public.platform_health_snapshot()",
  },
};

/** Returns the byte offset of the first invalid byte, or -1. */
function firstInvalidByteOffset(bytes: Buffer): number {
  try {
    strict.decode(bytes);
    return -1;
  } catch {
    // Narrow it down so the failure message names a location a human can open
    // rather than only a filename.
    for (let end = 1; end <= bytes.length; end += 1) {
      try {
        strict.decode(bytes.subarray(0, end));
      } catch {
        // A truncated multi-byte sequence at the cut also throws, so only a
        // prefix that stays invalid when extended is a real find.
        if (end + 4 <= bytes.length) {
          try {
            strict.decode(bytes.subarray(0, end + 4));
            continue;
          } catch {
            /* still invalid: fall through */
          }
        }
        return end - 1;
      }
    }
    return 0;
  }
}

describe("SQL source files are valid UTF-8", () => {
  for (const [label, dir] of [
    ["supabase/migrations", MIGRATIONS_DIR],
    ["supabase/tests", PSQL_TESTS_DIR],
  ] as const) {
    const files = sqlFiles(dir);

    it(`${label} has .sql files to check (non-vacuity control)`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const name of files) {
      if (label === "supabase/migrations" && name in KNOWN_INVALID) continue;
      it(`${label}/${name} decodes as strict UTF-8`, () => {
        const bytes = readFileSync(`${dir}/${name}`);
        const offset = firstInvalidByteOffset(bytes);
        expect(
          offset,
          offset < 0
            ? ""
            : `invalid UTF-8 byte 0x${bytes[offset].toString(16)} at byte offset ${offset}. ` +
              `Context: ${JSON.stringify(
                bytes.subarray(Math.max(0, offset - 40), offset + 20).toString("latin1"),
              )}. ` +
              `A committed migration is immutable — fix it ADDITIVELY, by re-creating ` +
              `the affected object from its latest definition with clean bytes.`,
        ).toBe(-1);
      });
    }
  }

  describe("the immutable-migration ledger", () => {
    const entries = Object.entries(KNOWN_INVALID);

    it("has exactly the one entry the pre-merge review found", () => {
      expect(entries.map(([name]) => name)).toEqual([
        "20260918001000_health_shows_the_deferred_lockout_queue.sql",
      ]);
    });

    for (const [name, { repairedBy, object }] of entries) {
      it(`${name} is genuinely invalid (a stale ledger entry is a failure too)`, () => {
        expect(firstInvalidByteOffset(readFileSync(`${MIGRATIONS_DIR}/${name}`))).toBeGreaterThan(
          -1,
        );
      });

      it(`${name} is repaired additively by ${repairedBy}, which is itself clean`, () => {
        const repair = readFileSync(`${MIGRATIONS_DIR}/${repairedBy}`);
        expect(firstInvalidByteOffset(repair)).toBe(-1);
        // Additive means LATER: the repair must apply after the file it repairs.
        expect(repairedBy > name).toBe(true);
        // ...and it must actually re-create the object whose stored source the
        // corruption reached, or the repair is a comment.
        const proc = object.replace(/\(\)$/, "");
        expect(repair.toString("utf8")).toContain(`create or replace function ${proc}()`);
      });
    }
  });
});
