// The things GetSetPaid asks consent for -- the TypeScript half of
// `private.consent_purposes()` (20260923000000), asserted equal to it by
// tests/unit/consent/catalogue.test.ts.
//
// CONSENT ONLY WHERE THE LAW REQUIRES IT (CLAUDE.md § Legal and regulatory
// compliance). Core CRM processing is contract, not consent, and strictly
// necessary storage is exempt under PECR -- so neither appears here, and the
// database refuses a purpose that is not on this list. `analytics` has no
// purpose because no analytics vendor is chosen (DECISIONS-QUEUE Q129); the
// day one is, its purpose is added here AND in a migration, together.
//
// THE STATEMENT. A consent is only as good as the words the person saw, so the
// exact sentence shown beside the control has an identifier, and every record
// stores that identifier (`technical_context.statement`). The identifier is
// PINNED to its text by hash in the unit test: changing a word without minting
// a new identifier is a red test, because an old record would otherwise point
// at words its subject never read.

import type { LegalSlug } from "@/lib/legal/documents";

/** Where a signed-in person makes these choices (app/(app)/account/privacy). */
export const ACCOUNT_PRIVACY_PATH = "/account/privacy";

export type ConsentCategory = "necessary" | "analytics" | "marketing";

export interface ConsentPurpose {
  readonly purpose: string;
  readonly category: ConsentCategory;
  /** The legal document whose published version a record points at. */
  readonly policySlug: LegalSlug;
  /** Identifier stored with every record; pinned to `statement` by hash. */
  readonly statementId: string;
  /** The sentence shown beside the control, verbatim. */
  readonly statement: string;
}

export const MARKETING_EMAIL: ConsentPurpose = {
  purpose: "marketing_email",
  category: "marketing",
  policySlug: "marketing-preferences",
  statementId: "marketing-email-1",
  statement:
    "I agree to GetSetPaid sending me occasional marketing email about its products and events. I can withdraw this at any time on this page.",
};

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [MARKETING_EMAIL];

export type ConsentAction = "granted" | "withdrawn";
