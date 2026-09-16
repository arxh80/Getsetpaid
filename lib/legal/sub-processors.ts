// The sub-processor register, as data -- the customer-facing half.
//
// ===========================================================================
// ONE LIST, TWO RENDERINGS, AND A TEST BETWEEN THEM
// ===========================================================================
// `docs/sub-processors.md` is the engineering register CLAUDE.md § Sub-
// processor / DPA register names: "a vendor is added there in the same change
// that first sends it personal data". The public Subprocessors page renders
// THIS module (the `{{subprocessors}}` block, which the database requires the
// `subprocessors` document to contain), not free text a superuser typed.
//
// Two lists that can drift would be the failure, so a test holds them
// together: `tests/unit/legal/sub-processors-drift.test.ts` parses the table
// in docs/sub-processors.md and asserts the same vendors, in the same order,
// with the same location and the same DPA status as this module -- and, since
// fix round 1 (M8), that each vendor's register Purpose and Personal-data
// cells equal the verbatim copies in `register` below. Adding a vendor to one
// list without the other, or rewriting what the register says a vendor does
// or holds, is a red unit test -- in CI, since that directory is the one CI
// runs. WHAT IT CANNOT PROVE: that the customer wording above still says what
// the register says. The two are different prose for different readers; the
// test forces a person to re-read one when the other changes, and that is
// the whole of the guarantee. (The first version of this comment said the
// lists "cannot drift", while the test compared four fields only.)
//
// Why not have the page read the Markdown file at runtime: the register is an
// engineering document written for counsel (file paths, Q numbers, the
// internal delivery seam), not customer copy, and the serverless bundle would
// have to carry a docs/ file to do it. The data here is the customer-facing
// wording of the same facts.

export interface SubProcessor {
  /** Exactly as the register's bold name cell reads. */
  readonly name: string;
  readonly purpose: string;
  readonly personalData: string;
  /** Exactly as the register's location cell reads. */
  readonly location: string;
  readonly transferBasis: string;
  readonly dpaSigned: boolean;
  /**
   * The register's own "Purpose" and "Personal data it processes" cells,
   * VERBATIM (fix round 1, M8). The public wording above is a rewrite of
   * these for customers, so the two cannot be compared word for word -- but a
   * change to either cell in docs/sub-processors.md now turns the drift test
   * red until this copy is updated, and updating it here puts the public
   * `purpose` and `personalData` directly above it, to be re-read in the same
   * change. Before this, rewriting the register's personal-data cell to
   * "Nothing at all" stayed green.
   */
  readonly register: { readonly purpose: string; readonly personalData: string };
}

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: "Supabase, Inc.",
    purpose:
      "Hosts the database, sign-in and file storage — the system of record for everything the service stores.",
    personalData:
      "Everything the service stores: account details, workspace records, uploaded documents and the audit trail.",
    // Fix round 2 (M1): this row said "UK/EU region only" and "No
    // international transfer" as fact. The region is a hosted-account setting
    // nothing in this repository enforces, and whether a US-incorporated
    // provider with no signed DPA involves a transfer is for counsel -- the
    // same two points the Privacy Notice and DPA leave open.
    location: "Incorporated in the United States; data hosted in a UK/EU region (deployment setting)",
    transferBasis:
      "Not yet confirmed: whether this provider's incorporation in the United States involves a transfer of personal data outside the UK, and the safeguards for it, is for counsel to confirm.",
    dpaSigned: false,
    register: {
      purpose: "Database, authentication, file storage — the system of record",
      personalData:
        "Everything the product stores: account identities, workspace records, documents, audit trail",
    },
  },
  {
    name: "Brevo (Sendinblue SAS)",
    purpose:
      "Sends transactional email: feedback receipts and security alerts to our support contact, and account-lockout notices to the affected account holder.",
    personalData:
      "Email addresses of recipients; for a feedback receipt, the submitter’s email address, workspace name, role, the page they were on and the message they wrote.",
    location: "France (EU)",
    transferBasis:
      "The EEA is covered by the UK’s adequacy regulations, so no additional transfer safeguards are needed.",
    dpaSigned: false,
    register: {
      purpose:
        "**Built:** transactional email — the in-app feedback receipt and the incident-alert digest to the support contact, and the account-lockout notice to the affected account holder (`lib/email/send.ts`, `lib/email/lockout-notification.ts`). **Not yet configured:** Supabase Auth SMTP relay for sign-up, magic-link and reset mail — a hosted-project setting (`docs/email-setup.md` § 3) that nothing in the repository configures today; this row's scope widens to auth mail only when that step is done",
      personalData:
        "**Today:** the support contact's address; for a feedback receipt, the submitter's email, workspace name, role, the page path and **the message text they typed**; for a lockout notice, the locked account's email address. **Once the Auth relay is configured:** every user's address, on every sign-up / magic link / reset",
    },
  },
];
