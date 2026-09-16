// Every piece of browser storage the product sets, declared once.
//
// The Cookie Policy renders this list (the `{{storage_inventory}}` block, which
// the database REQUIRES the `cookies` document to contain -- CHECK
// `legal_documents_required_blocks`), so the page cannot describe a different
// set from the one declared here.
//
// DECISIONS-QUEUE Q129: all four are strictly necessary, which PECR exempts
// from consent, and no analytics vendor is chosen -- so no cookie banner ships.
// Phase 8 Task 2 adds the census that fails the moment the codebase sets a
// cookie or storage key that is not on this list, which is what turns "adding
// analytics" into a forced banner decision rather than a silent one. Until
// then, `tests/unit/legal/storage-inventory.test.ts` pins each entry to the
// source constant it describes, so a renamed key is a red test.

export type StorageKind = "cookie" | "local-storage";

export interface StorageItem {
  /** The name as it appears in the browser's storage inspector. */
  readonly name: string;
  readonly kind: StorageKind;
  /** Who sets it -- always this service; there are no third-party items. */
  readonly setBy: string;
  readonly purpose: string;
  readonly duration: string;
  /** Why PECR's strictly-necessary exemption applies. */
  readonly necessity: string;
}

export const BROWSER_STORAGE: readonly StorageItem[] = [
  {
    name: "sb-…-auth-token (and numbered parts, plus a short-lived …-code-verifier during Google or email-link sign-in)",
    kind: "cookie",
    setBy: "GetSetPaid, through its authentication provider (Supabase)",
    purpose:
      "Keeps you signed in, so each page you open knows which account is asking.",
    duration:
      "Up to 400 days in the browser, removed when you sign out. The session it carries expires much sooner — you are signed out after 30 minutes without activity.",
    necessity: "Required to provide the signed-in service you asked for.",
  },
  {
    name: "gsp_current_org",
    kind: "cookie",
    setBy: "GetSetPaid",
    purpose:
      "Remembers which workspace you last opened, so you return to it after signing in. Not readable by page scripts.",
    duration: "180 days, renewed when you switch workspace.",
    necessity: "Part of the multi-workspace service you asked for; carries no tracking.",
  },
  {
    name: "gsp:last-activity-at:<your account id>",
    kind: "local-storage",
    setBy: "GetSetPaid",
    purpose:
      "Records when you were last active, so an idle session is signed out after 30 minutes — including across open tabs.",
    duration: "Until you sign out (it is cleared then) or clear your browser storage.",
    necessity: "A security control on the signed-in service.",
  },
  {
    name: "gsp:sidebar-pinned",
    kind: "local-storage",
    setBy: "GetSetPaid",
    purpose:
      "Remembers whether you pinned the navigation rail open. Only written when you press the pin control.",
    duration: "Until you change it or clear your browser storage.",
    necessity: "Remembers a display choice you made yourself.",
  },
];

export const STORAGE_KIND_LABELS: Record<StorageKind, string> = {
  cookie: "Cookie",
  "local-storage": "Local storage",
};
