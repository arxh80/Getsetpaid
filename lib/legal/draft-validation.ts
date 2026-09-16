// Save-time validation of a legal-document draft -- layer 1 of the three in
// lib/legal/markup.ts's header. Pure, so it is unit-tested directly.
//
// Every rule here has a database twin in 20260922000000 (the CHECK
// constraints); this layer exists to turn a refusal into a sentence next to
// the field it is about, not to be the control.

import type { LegalSlug } from "./documents";
import {
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  STORAGE_INVENTORY_TOKEN,
  SUBPROCESSORS_TOKEN,
  SUPPORT_EMAIL_TOKEN,
  parseLegalMarkup,
} from "./markup";

/** Placeholders a document must contain -- mirrors the
 *  `legal_documents_required_blocks` CHECK. */
export const REQUIRED_PLACEHOLDERS: Partial<Record<LegalSlug, readonly string[]>> = {
  cookies: [STORAGE_INVENTORY_TOKEN],
  subprocessors: [SUBPROCESSORS_TOKEN],
  contact: [SUPPORT_EMAIL_TOKEN],
  "vulnerability-disclosure": [SUPPORT_EMAIL_TOKEN],
};

const REQUIRED_REASON: Record<string, string> = {
  [STORAGE_INVENTORY_TOKEN]:
    "it renders the list of cookies and storage the service actually sets",
  [SUBPROCESSORS_TOKEN]: "it renders the subprocessor register",
  [SUPPORT_EMAIL_TOKEN]: "it renders the configured contact address",
};

export interface DraftInput {
  readonly title: string;
  readonly body: string;
  readonly effectiveDate: string;
}

export type DraftValidation =
  | { readonly ok: true; readonly value: DraftInput }
  | { readonly ok: false; readonly fieldErrors: Record<string, string> };

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

export function validateDraft(slug: LegalSlug, input: DraftInput): DraftValidation {
  const fieldErrors: Record<string, string> = {};
  const title = input.title.trim();
  const body = input.body.replace(/\r\n?/g, "\n");

  if (title === "") fieldErrors.title = "Give the document a title.";
  else if (title.length > MAX_TITLE_LENGTH) {
    fieldErrors.title = `Keep the title to ${MAX_TITLE_LENGTH} characters.`;
  }

  if (!isCalendarDate(input.effectiveDate)) {
    fieldErrors.effectiveDate = "Enter the date this version takes effect.";
  }

  if (body.trim() === "") {
    fieldErrors.body = "The document has no text.";
  } else if (body.length > MAX_BODY_LENGTH) {
    fieldErrors.body = `The document is longer than ${MAX_BODY_LENGTH.toLocaleString("en-GB")} characters.`;
  } else {
    const problems = [...parseLegalMarkup(body).problems];
    for (const token of REQUIRED_PLACEHOLDERS[slug] ?? []) {
      if (!body.includes(token)) {
        problems.push(`This document must contain ${token} — ${REQUIRED_REASON[token]}.`);
      }
    }
    if (problems.length > 0) fieldErrors.body = problems.join(" ");
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, value: { title, body, effectiveDate: input.effectiveDate } };
}
