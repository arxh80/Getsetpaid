// Every piece of browser storage the product sets, declared once.
//
// The Cookie Policy renders this list (the `{{storage_inventory}}` block, which
// the database REQUIRES the `cookies` document to contain -- CHECK
// `legal_documents_required_blocks`), so the page cannot describe a different
// set from the one declared here.
//
// DECISIONS-QUEUE Q129: all four are strictly necessary, which PECR exempts
// from consent, and no analytics vendor is chosen -- so no cookie banner ships.
// Three checks hold this list to the truth:
//   * tests/unit/legal/storage-inventory.test.ts pins each entry to the source
//     constant it describes, so a RENAMED key is a red test;
//   * tests/unit/legal/storage-census.test.ts (Phase 8 Task 2) parses every
//     app-shipped source file for the cookie-write, Web Storage, IndexedDB /
//     Cache API, third-party-load and tracker shapes that
//     tests/unit/legal/storage-scanner.ts lists, and fails on one this list
//     does not explain -- so a NEW key, or an analytics loader, written in a
//     recognised shape is a red test;
//   * tests/e2e/storage-census.spec.ts reads what a real browser actually
//     holds after a signed-in walk and requires every cookie and storage key
//     to match an entry's `matches` pattern -- which catches what a library
//     sets and the source scan cannot see.
// That is what turns "adding analytics" into a forced banner decision rather
// than a silent one (SECURITY.md § 8, "Browser storage and consent", says what
// has to ship with it).

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
  /** Every name, as a browser reports it, that this entry covers. Not
   *  rendered: it is what the browser-level census matches against. */
  readonly matches: RegExp;
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
    // sb-<project ref>-auth-token, its numbered chunks and the PKCE verifier.
    // Locally the "ref" is the API host's first label (127).
    matches: /^sb-[a-z0-9]+-auth-token(-code-verifier)?(\.[0-9]+)?$/,
  },
  {
    name: "gsp_current_org",
    kind: "cookie",
    setBy: "GetSetPaid",
    purpose:
      "Remembers which workspace you last opened, so you return to it after signing in. Not readable by page scripts.",
    duration: "180 days, renewed when you switch workspace.",
    necessity: "Part of the multi-workspace service you asked for; carries no tracking.",
    matches: /^gsp_current_org$/,
  },
  {
    name: "gsp:last-activity-at:<your account id>",
    kind: "local-storage",
    setBy: "GetSetPaid",
    purpose:
      "Records when you were last active, so an idle session is signed out after 30 minutes — including across open tabs.",
    duration: "Until you sign out (it is cleared then) or clear your browser storage.",
    necessity: "A security control on the signed-in service.",
    matches: /^gsp:last-activity-at:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  },
  {
    name: "gsp:sidebar-pinned",
    kind: "local-storage",
    setBy: "GetSetPaid",
    purpose:
      "Remembers whether you pinned the navigation rail open. Only written when you press the pin control.",
    duration: "Until you change it or clear your browser storage.",
    necessity: "Remembers a display choice you made yourself.",
    matches: /^gsp:sidebar-pinned$/,
  },
];

export const STORAGE_KIND_LABELS: Record<StorageKind, string> = {
  cookie: "Cookie",
  "local-storage": "Local storage",
};
