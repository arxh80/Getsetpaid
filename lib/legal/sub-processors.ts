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
// internal delivery seam), not customer copy, and the deployed bundle would
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
    // international transfer" as fact. Whether a US-incorporated provider
    // with no signed DPA involves a transfer is still for counsel -- the same
    // point the Privacy Notice and DPA leave open.
    //
    // Q145, founder 2026-09-30: the production project's region is Ireland
    // (eu-west-1). The "(deployment setting)" marker this cell carried while
    // the region was unconfirmed is gone; the region is now stated by name.
    location: "Incorporated in the United States; data hosted in Ireland (eu-west-1)",
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
  {
    // Q142, founder 2026-09-30: the application host is an IONOS VPS. IONOS
    // SE is a German company; the server is not bought yet and its region is
    // "most likely UK" -- so the region is stated as PENDING, never guessed.
    // When the server is bought, this cell and the register's change together
    // (the drift test binds them) and the four hosting pages are republished.
    name: "IONOS SE",
    purpose:
      "Will host the application servers, which handle every request to the service. The server has not been set up yet.",
    personalData:
      "Everything that passes through a request: session cookies, IP addresses, and the pages, records and files each request reads or writes.",
    location: "Incorporated in Germany (EU); server region PENDING — the server has not been set up yet",
    transferBasis:
      "Not yet confirmed: it depends on the server's region, which is pending. Counsel to confirm the basis once the region is chosen.",
    dpaSigned: false,
    register: {
      purpose:
        "Application host — the virtual private server the Next.js application will run on. **Not yet bought:** nothing is deployed to it today",
      personalData:
        "Every request and response: session cookies, IP addresses, page content, form submissions and uploads in transit",
    },
  },
];
