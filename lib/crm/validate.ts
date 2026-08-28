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
 * Split a comma-separated tag input into a clean `text[]`.
 *
 * Trims, drops blanks, de-duplicates case-insensitively while keeping the
 * first spelling the user typed, and caps both the number and the length. The
 * cap is here rather than in the schema for the same reason as MAX_SHORT_TEXT.
 */
export const MAX_TAGS = 25;
export const MAX_TAG_LENGTH = 40;

export function parseTags(raw: string | null): {
  readonly tags: string[];
  readonly problem: FieldProblem | null;
} {
  if (raw === null) return { tags: [], problem: null };
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag === "") continue;
    if (tag.length > MAX_TAG_LENGTH) {
      return {
        tags: [],
        problem: {
          field: "tags",
          message: `Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`,
        },
      };
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    return {
      tags: [],
      problem: { field: "tags", message: `Use ${MAX_TAGS} tags or fewer.` },
    };
  }
  return { tags, problem: null };
}

/** The inverse, for rendering the stored array back into the input. */
export function formatTags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}
