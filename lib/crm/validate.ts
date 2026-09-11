// Shared field validation for the CRM entity forms.
//
// Deliberately small, and every rule here is one the DATABASE also holds or
// deliberately does not. Where the database holds it, this exists to produce a
// sentence instead of a raised Postgres exception. Where the database does
// not, this is the only check -- and each of those is named.
//
// ===========================================================================
// WHAT IS NOT VALIDATED, AND WHY THAT IS A DECISION RATHER THAN AN OMISSION
// ===========================================================================
// `contacts.email` and `contacts.phone` are nullable and unvalidated at the
// database (20260827232510). The brief asks what the application enforces.
//
// EMAIL: `lib/forms.ts`'s deliberately permissive check, reused rather than
// re-invented. It rejects a missing `@`, a missing dot in the domain, embedded
// whitespace and anything over RFC 5321's 254-character path limit, and it
// accepts everything else. A live-events CRM stores `booking@`, `info+ra@`,
// long new TLDs and apostrophes in local parts; an over-clever regex rejects
// real addresses and teaches the user the product is broken. Real validity is
// only ever established by delivering mail.
//
// PHONE: LENGTH AND CHARACTER SET ONLY, and no format at all. This is the one
// most likely to be read as laziness, so: a UK CRM's phone column holds
// `+44 7700 900123`, `07700 900123`, `+1 (212) 555-0147`, `+49 30 901820`,
// `020 7946 0958 ext 12`, and every one of those is correct for the person it
// belongs to. E.164 normalisation needs a country hint this form does not
// have; a regex that "looks like a phone number" rejects extensions and
// international formats users type correctly. So: 5 to 40 characters, digits
// plus the punctuation people actually use, which rejects a pasted paragraph
// and an injected URL without pretending to know what a phone number is.
//
// TAGS and `companies.type` are the mirror-image pair, and the difference is
// in the schema: `tags` is free text by design (20260827232510 says so, and
// says why), `type` is checked element-wise against a closed set. So tags are
// only length-capped and de-duplicated, and `type` is validated against the
// vocabulary before the database gets the chance to raise a constraint error.

import { isValidEmail } from "@/lib/forms";

/**
 * Every free-text CRM column is unbounded `text` in the schema. That is right
 * for the schema -- an arbitrary limit in a migration is a migration to change
 * later -- and wrong for a form, because a megabyte pasted into `title`
 * renders on every list page from then on. 200 is generous for a job title, a
 * city or a person's name and small enough to keep a table row a table row.
 */
export const MAX_SHORT_TEXT = 200;

/** `name` is the identity of every entity in this phase. */
export const MAX_NAME = 200;

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/** Required, non-blank after trimming, capped. Mirrors `btrim(name) <> ''`. */
export function checkName(value: string | null): FieldProblem | null {
  if (value === null) return { field: "name", message: "Enter a name." };
  if (value.length > MAX_NAME) {
    return { field: "name", message: `Use ${MAX_NAME} characters or fewer.` };
  }
  return null;
}

export function checkShortText(
  field: string,
  value: string | null,
  label: string,
): FieldProblem | null {
  if (value !== null && value.length > MAX_SHORT_TEXT) {
    return { field, message: `${label} must be ${MAX_SHORT_TEXT} characters or fewer.` };
  }
  return null;
}

/**
 * The cap for the two columns that are meant to hold a PARAGRAPH.
 *
 * `artists.notes` (PRD 6.3) and `venues.technical_info` (PRD 6.4) are
 * deliberately unstructured free text -- 20260827232510 says structuring the
 * second "would be inventing a spec sheet nobody asked for" -- so
 * MAX_SHORT_TEXT would refuse the thing they exist for: a load-in paragraph, a
 * list of what the PA is, three sentences about how the artist likes to be
 * booked.
 *
 * 4,000 characters is roughly a page and a half. The cap is here rather than
 * in the schema for the same reason as MAX_SHORT_TEXT -- an arbitrary limit in
 * a migration is a migration to change later -- and it exists at all because
 * the column is unbounded `text` and a megabyte pasted into it renders on
 * every load of that record's page from then on.
 *
 * IT IS A LENGTH CAP AND NOT A SANITISER. Both columns are untrusted user
 * content and are rendered as TEXT, never as HTML and never through
 * `dangerouslySetInnerHTML` (CLAUDE.md § Non-negotiable rules). React escapes
 * them on the way out; nothing here strips anything, because stripping would
 * silently rewrite what a user typed about their own venue.
 */
export const MAX_LONG_TEXT = 4000;

export function checkLongText(
  field: string,
  value: string | null,
  label: string,
): FieldProblem | null {
  if (value !== null && value.length > MAX_LONG_TEXT) {
    return {
      field,
      message: `${label} must be ${MAX_LONG_TEXT.toLocaleString("en-GB")} characters or fewer.`,
    };
  }
  return null;
}

export function checkEmail(value: string | null): FieldProblem | null {
  if (value === null) return null;
  if (!isValidEmail(value)) {
    return {
      field: "email",
      message: "That doesn’t look like an email address. Check for a typo.",
    };
  }
  return null;
}

/**
 * Digits and the punctuation real phone numbers are written with. See the file
 * header for why there is no format check.
 */
const PHONE_SHAPE = /^[0-9+()./\- x]{5,40}$/i;

export function checkPhone(value: string | null): FieldProblem | null {
  if (value === null) return null;
  if (!PHONE_SHAPE.test(value)) {
    return {
      field: "phone",
      message:
        "Use digits, spaces and + ( ) - only, between 5 and 40 characters.",
    };
  }
  return null;
}

/**
 * Split a comma-separated free-text input into a clean `text[]`.
 *
 * Trims, drops blanks, de-duplicates case-insensitively while keeping the
 * first spelling the user typed, and caps both the number and the length. The
 * cap is here rather than in the schema for the same reason as MAX_SHORT_TEXT.
 *
 * ===========================================================================
 * ONE IMPLEMENTATION, TWO COLUMNS, AND THE FIELD NAME IS A PARAMETER
 * ===========================================================================
 * `contacts.tags` and `artists.genres` are the same column twice: both
 * `text[] not null default '{}'`, both deliberately unallowlisted (there is no
 * agreed genre vocabulary in this industry and 20260827232510 says inventing
 * one would be a product decision), and both typed into one comma-separated
 * input. Task 4b needed the second and this file had the first, so the choice
 * was to copy thirty lines or to pass the field name and the noun.
 *
 * The field name has to travel because `FieldProblem.field` is the INPUT NAME
 * the message is rendered next to -- returning `field: "tags"` from the artist
 * form would render "Use 25 tags or fewer" beside nothing at all, which is a
 * WCAG failure wearing a validation message's clothes.
 */
const MAX_TAGS = 25;
const MAX_TAG_LENGTH = 40;

function parseTextArray(
  raw: string | null,
  field: string,
  noun: { one: string; many: string },
): { readonly values: string[]; readonly problem: FieldProblem | null } {
  if (raw === null) return { values: [], problem: null };
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    if (value.length > MAX_TAG_LENGTH) {
      return {
        values: [],
        problem: {
          field,
          message: `Each ${noun.one} must be ${MAX_TAG_LENGTH} characters or fewer.`,
        },
      };
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  if (values.length > MAX_TAGS) {
    return {
      values: [],
      problem: { field, message: `Use ${MAX_TAGS} ${noun.many} or fewer.` },
    };
  }
  return { values, problem: null };
}

export function parseTags(raw: string | null): {
  readonly tags: string[];
  readonly problem: FieldProblem | null;
} {
  // The property name stays `tags` rather than becoming `values`: every call
  // site in lib/crm/contacts.ts destructures it, and renaming a field to share
  // an implementation is a diff that touches proven code for no behavioural
  // reason.
  const { values, problem } = parseTextArray(raw, "tags", {
    one: "tag",
    many: "tags",
  });
  return { tags: values, problem };
}

export function parseGenres(raw: string | null): {
  readonly genres: string[];
  readonly problem: FieldProblem | null;
} {
  const { values, problem } = parseTextArray(raw, "genres", {
    one: "genre",
    many: "genres",
  });
  return { genres: values, problem };
}

/** The inverse, for rendering the stored array back into the input. */
export function formatTags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}

/**
 * `venues.capacity`: a whole number of people, or nothing.
 *
 * ===========================================================================
 * BLANK MEANS UNKNOWN. IT NEVER MEANS ZERO.
 * ===========================================================================
 * 20260827232510 makes the column nullable and says why in as many words:
 * "capacity is frequently unknown when a venue is first entered, and 0 would
 * be a lie that then renders as a real number in the UI". So an empty input
 * has to reach the database as NULL, and the one thing this function must not
 * do is coerce it -- `Number("")` is `0`, which is exactly the lie, and it is
 * the default behaviour of every obvious implementation.
 *
 * `check (capacity is null or capacity >= 0)` is the database's half. This is
 * the half that produces a sentence next to the field instead of a raised
 * 23514 rendered as "something went wrong", and it adds two rules the CHECK
 * cannot express: it must be a WHOLE number (the column is `integer`, so
 * PostgREST would refuse "1200.5" with a parse error nobody can read), and it
 * has an upper bound.
 *
 * THE UPPER BOUND IS 1,000,000 AND IT IS NOT `integer`'s. A venue capacity is
 * a room, a field or a stadium; the largest stadium on earth holds about
 * 150,000. A million is far past any real answer and far below `integer`'s
 * 2,147,483,647, which is the number a typo like "12000000000" would otherwise
 * have to hit before anything complained -- and it would not complain here, it
 * would raise 22003 from Postgres.
 */
export const MAX_CAPACITY = 1_000_000;

export function checkCapacity(value: string | null): {
  readonly capacity: number | null;
  readonly problem: FieldProblem | null;
} {
  // NOT `value === ""`: lib/forms.ts's `field()` has already turned an empty
  // or whitespace-only input into null. This is the unknown case and it is the
  // common one.
  if (value === null) return { capacity: null, problem: null };
  // A strict integer, sign included so "-40" is rejected here with a sentence
  // rather than by the CHECK constraint. No thousands separators: "1,200" is
  // refused rather than silently read as 1, which is what parseInt would do.
  if (!/^[+-]?\d+$/.test(value)) {
    return {
      capacity: null,
      problem: {
        field: "capacity",
        message: "Use a whole number, like 800. Leave it blank if you don’t know it.",
      },
    };
  }
  const capacity = Number(value);
  if (capacity < 0) {
    return {
      capacity: null,
      problem: { field: "capacity", message: "Capacity can’t be negative." },
    };
  }
  if (capacity > MAX_CAPACITY) {
    return {
      capacity: null,
      problem: {
        field: "capacity",
        message: `That’s larger than any venue. Use ${MAX_CAPACITY.toLocaleString("en-GB")} or fewer.`,
      },
    };
  }
  return { capacity, problem: null };
}

/**
 * A `date` column from a form: `YYYY-MM-DD`, or nothing.
 *
 * ===========================================================================
 * A DATE, NOT AN INSTANT, AND THE STRING IS NEVER TURNED INTO A `Date`
 * ===========================================================================
 * `artist_representations.started_at` / `ended_at` are `date`, and
 * 20260827232510 convention (4) says why: "a representation starting on the
 * 3rd started on the 3rd everywhere", so storing it as an instant invents a
 * time of day that then shifts under conversion. The value therefore travels
 * as the string the `<input type="date">` produced, all the way to PostgREST,
 * and comes back the same way. Parsing it into a JavaScript `Date` -- which
 * `new Date("2026-03-03")` reads as UTC MIDNIGHT -- and formatting it in
 * Europe/London during BST is how "3 March" becomes "2 March" on the detail
 * page.
 *
 * So this validates the SHAPE and the calendar and returns the string. The
 * calendar check is real work: `2026-02-30` matches the pattern, and Postgres
 * would answer 22008 ("date/time field value out of range") which reaches the
 * user as a fault rather than as a field error.
 */
export function checkDate(
  field: string,
  value: string | null,
  label: string,
): { readonly value: string | null; readonly problem: FieldProblem | null } {
  if (value === null) return { value: null, problem: null };
  const bad = {
    value: null,
    problem: { field, message: `${label} must be a real date.` },
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad;
  const [y, m, d] = value.split("-").map(Number);
  // Round-tripped through UTC, so no timezone can move the day. The equality
  // is what catches 2026-02-30 -> 2026-03-02.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return bad;
  }
  // The column is `date`, whose range starts at 4713 BC, but a four-digit year
  // outside living memory is a typo (`0202` for `2020`) rather than a fact.
  if (y < 1900 || y > 2200) return bad;
  return { value, problem: null };
}

