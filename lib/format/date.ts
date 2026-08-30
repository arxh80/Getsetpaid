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
