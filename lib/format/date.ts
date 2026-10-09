// Dates, formatted once.
//
// ===========================================================================
// WHY THIS FILE EXISTS
// ===========================================================================
// Final review I-10 (deferred-minor L947) counted TWENTY-FIVE copies of these
// three functions across `app/` and `components/`, byte-identical within each
// shape. The duplication was not the danger on its own -- the timezone pinning
// is: `CLAUDE.md` § Non-negotiable rules asks for "UTC in the database, UK
// local time in the UI with explicit timezone handling", and one drifted copy
// produces a page that renders UTC while every other page renders UK local,
// with nothing to catch it. Twenty-five chances to drift, no mirror test.
//
// ===========================================================================
// TWO KINDS OF VALUE, AND THEY ARE NOT INTERCHANGEABLE
// ===========================================================================
// `timestamptz` is an INSTANT. It happened at one moment and every viewer
// should see it in UK local time -- `Europe/London`, so a record created at
// 23:30 UTC in July reads as 00:30 the next day, which is when it happened
// here.
//
// `date` is a CALENDAR FACT. A representation that started on the 3rd started
// on the 3rd everywhere (20260827232510 convention (4)). `new Date("2026-03-03")`
// parses as UTC midnight and then renders in the viewer's zone, which is the
// day before west of Greenwich -- so these go in through `Date.UTC` and out
// through `timeZone: "UTC"`, and the day that comes back is the day that was
// stored.
//
// Using the wrong one is a silent off-by-one-day, which is why they have
// different names rather than a flag. `formatDateOnly` is the `date` one.
//
// The functions take and return strings and touch nothing else, so this module
// is safe in a Server Component and in a "use client" one alike.

const UK = "Europe/London";

/** An instant as a day: `03 Mar 2026`, in UK local time. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: UK,
  });
}

/** An instant as a day and a time: `03 Mar 2026, 00:30`, in UK local time. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: UK,
  });
}

/**
 * A `date` column as a date, with NO timezone conversion.
 *
 * Takes the `YYYY-MM-DD` PostgREST returns, not an instant. The day that comes
 * back is the day that was stored, in every viewer's zone.
 */
export function formatDateOnly(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ===========================================================================
// THE FORM DIRECTION, ADDED BY PHASE 3 TASK 4
// ===========================================================================
// Everything above renders an INSTANT that is already in the database. The two
// functions below are the other direction: an `<input type="datetime-local">`
// yields `2026-09-04T22:00` -- a WALL CLOCK with no zone at all -- and
// `events.starts_at` is `timestamptz`, so something has to decide which
// instant that wall clock names.
//
// `new Date("2026-09-04T22:00")` decides it with the SERVER'S zone. That is
// correct on a UK laptop, wrong on a server running UTC (an event at 22:00
// on a July evening is stored an hour late and reads back as 23:00), and wrong
// AGAIN on both machines across the two days a year the offset changes.
// CLAUDE.md § Non-negotiable rules asks for "UTC in the database, UK local
// time in the UI with EXPLICIT timezone handling", and this is the explicit
// half: the zone is Europe/London because it is written here, not because of
// what `TZ` happens to be set to where the code runs.
//
// NO NEW DEPENDENCY. `Intl.DateTimeFormat` with `timeZone: "Europe/London"`
// already carries the whole transition history, so the offset at an instant is
// one `formatToParts` call and a subtraction. A date library would be a
// megabyte to avoid ten lines. Q37: Europe/London is hard-coded at MVP -- the
// product is UK-first and there is no per-user timezone setting to read.

/**
 * How Europe/London reads one instant.
 *
 * The trick this half of the file rests on: format the instant in London, then
 * feed the resulting Y/M/D h:m:s back through `Date.UTC`. The number that
 * comes out is NOT the instant -- it is the London wall clock expressed in the
 * only arithmetic JavaScript has for a naive datetime. Subtract the instant
 * from it and the difference is the offset in milliseconds.
 */
const LONDON_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // h23 rather than `hour12: false`, which some ICU versions render as "24"
  // for midnight. The `% 24` below is a second belt for the same buckle.
  hourCycle: "h23",
});

interface LondonParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function londonPartsAt(instant: number): LondonParts {
  const parts = LONDON_CLOCK.formatToParts(new Date(instant));
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: String(Number(read("hour")) % 24).padStart(2, "0"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** The London wall clock at `instant`, as the pseudo-UTC number above. */
function londonWallClockNumberAt(instant: number): number {
  const p = londonPartsAt(instant);
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** `<input type="datetime-local">`'s value, with the optional seconds. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const DAY_MS = 86_400_000;

/**
 * `"2026-09-04T22:00"` (Europe/London wall clock) -> an ISO instant in UTC.
 *
 * `null` when the string is not a datetime-local value, is not a real calendar
 * date (`2026-02-30` matches the pattern and is not a day), or carries a year
 * outside 1900-2200 -- `lib/crm/validate.ts`'s `checkDate` draws the same
 * bound for the same reason: a four-digit year outside living memory is `0202`
 * typed for `2020`, not a fact.
 *
 * ===========================================================================
 * THE TWO DAYS A YEAR THE ANSWER IS NOT A FUNCTION OF THE WALL CLOCK
 * ===========================================================================
 * An offset cannot simply be looked up "at" a wall clock, because the wall
 * clock is what the offset decides. So BOTH plausible offsets are taken -- the
 * one a day earlier and the one a day later, which straddle any transition --
 * each is subtracted, and each candidate instant is checked by formatting it
 * back: a candidate is REAL only if London really reads it as the wall clock
 * that was asked for.
 *
 *   Ordinary day       both offsets equal, one candidate, it round-trips.
 *   29 March 2026      01:30 NEVER HAPPENS. Neither candidate round-trips.
 *   25 October 2026    01:30 HAPPENS TWICE. Both candidates round-trip.
 *
 * AMBIGUOUS -> THE FIRST OCCURRENCE WINS. `2026-10-25T01:30` is 00:30Z (BST),
 * not 01:30Z (GMT). It is a choice and not a fact -- the input carries no
 * information that could separate them -- and it is the earlier of the two, so
 * a list sorted by `starts_at` keeps two events entered in that order in that
 * order. It is also what `Temporal`'s "compatible" disambiguation does, so the
 * day this moves to `Temporal.ZonedDateTime` nothing changes.
 *
 * NON-EXISTENT -> SHIFTED FORWARD by the missing hour. `2026-03-29T01:30`
 * becomes 01:30Z, which reads back as 02:30 BST. The alternative is to return
 * null and render "That doesn't look like a date and time" over a string that
 * looks perfectly ordinary, which teaches the user the product is broken.
 * `Temporal`'s "compatible" does the same. The user sees 02:30 on the detail
 * page and can correct it if they meant something else.
 */
export function londonWallClockToInstant(value: string): string | null {
  const match = WALL_CLOCK.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  // Round-tripped through UTC, so no zone can move the day. The equality is
  // what catches 2026-02-30 -> 2026-03-02.
  const probe = new Date(wanted);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  // A day either side straddles any transition: no two London transitions are
  // less than months apart, so these are exactly the two offsets in play.
  const before = londonWallClockNumberAt(wanted - DAY_MS) - (wanted - DAY_MS);
  const after = londonWallClockNumberAt(wanted + DAY_MS) - (wanted + DAY_MS);
  const candidates =
    before === after ? [wanted - before] : [wanted - before, wanted - after];

  const real = candidates
    .filter((candidate) => londonWallClockNumberAt(candidate) === wanted)
    .sort((a, b) => a - b);
  // The first occurrence when there are two; the only one when there is one.
  if (real.length > 0) return new Date(real[0]).toISOString();
  // The gap. The later candidate is the one shifted forward past it.
  return new Date(Math.max(...candidates)).toISOString();
}

/**
 * The inverse, for populating a `datetime-local` input from a stored instant.
 *
 * Returns `""` for a value `Date` cannot parse, because the only caller is a
 * `defaultValue` and an empty input is the honest rendering of a column
 * nothing can read. It does NOT return null: a null `defaultValue` makes an
 * uncontrolled input controlled-then-uncontrolled in React, which warns.
 *
 * SECONDS ARE DROPPED. `datetime-local` without a `step` shows minutes, so
 * rendering a `:30` an input cannot display would silently rewrite the stored
 * instant on the next save.
 */
export function instantToLondonWallClock(iso: string): string {
  const instant = new Date(iso).getTime();
  if (Number.isNaN(instant)) return "";
  const p = londonPartsAt(instant);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
