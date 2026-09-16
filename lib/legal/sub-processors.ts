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
// Two lists that can drift would be the failure, so they cannot:
// `tests/unit/legal/sub-processors-drift.test.ts` parses the table in
// docs/sub-processors.md and asserts the same vendors, in the same order,
// with the same location and the same DPA status as this module. Adding a
// vendor to one without the other is a red unit test -- in CI, since that
// directory is the one CI runs.
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
}

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: "Supabase, Inc.",
    purpose:
      "Hosts the database, sign-in and file storage — the system of record for everything the service stores.",
    personalData:
      "Everything the service stores: account details, workspace records, uploaded documents and the audit trail.",
    location: "UK/EU region only",
    transferBasis: "No international transfer: the data is hosted in the UK/EU region.",
    dpaSigned: false,
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
  },
];
