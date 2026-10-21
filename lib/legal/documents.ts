// The fifteen legal pages PRD §12 requires, as a closed catalogue.
//
// ===========================================================================
// WHAT THIS FILE IS, AND WHAT IT IS NOT
// ===========================================================================
// It is the list of SLUGS (the URL and the database key) and the NAVIGATION
// TITLE of each page -- what the footer, the /legal index and the superuser
// editor's list show before any document is read.
//
// It is NOT the content. Every page's title and body live in
// `public.legal_documents`, one row per (slug, version), and are edited by the
// platform superuser from /super/legal without a deploy (DECISIONS-QUEUE
// Q128). The page's own <h1> is the stored title, so counsel can retitle a
// document; the catalogue title here is only the link text.
//
// The slug set is written TWICE, and that is deliberate: here, and in the
// `legal_documents_slug_known` CHECK constraint in
// supabase/migrations/20260922000000_legal_documents.sql. The database's copy
// is the enforcement (an unknown slug cannot be stored); this copy is what the
// app routes on. tests/integration/legal/legal-documents.test.ts reads the
// live constraint and the live rows and asserts the two agree, so a slug added
// to one and not the other is a red test naming itself.

export const LEGAL_DOCUMENTS = [
  { slug: "privacy", title: "Privacy Notice", group: "privacy" },
  { slug: "cookies", title: "Cookie Policy", group: "privacy" },
  { slug: "data-retention", title: "Data Retention Policy", group: "privacy" },
  { slug: "data-subject-rights", title: "Your Data Protection Rights", group: "privacy" },
  {
    slug: "marketing-preferences",
    title: "Marketing and Communications Preferences",
    group: "privacy",
  },
  { slug: "subprocessors", title: "Subprocessors", group: "privacy" },
  { slug: "terms", title: "Terms of Service", group: "terms" },
  { slug: "acceptable-use", title: "Acceptable Use Policy", group: "terms" },
  { slug: "data-processing-addendum", title: "Data Processing Addendum", group: "terms" },
  { slug: "community-guidelines", title: "Network Community Guidelines", group: "terms" },
  { slug: "ai-use", title: "AI Use Policy", group: "terms" },
  { slug: "security", title: "Security and Trust", group: "trust" },
  {
    slug: "vulnerability-disclosure",
    title: "Vulnerability Disclosure Policy",
    group: "trust",
  },
  { slug: "accessibility", title: "Accessibility Statement", group: "trust" },
  { slug: "contact", title: "Contact and Complaints", group: "trust" },
] as const;

export type LegalDocumentEntry = (typeof LEGAL_DOCUMENTS)[number];
export type LegalSlug = LegalDocumentEntry["slug"];
export type LegalGroup = LegalDocumentEntry["group"];

export const LEGAL_GROUP_LABELS: Record<LegalGroup, string> = {
  privacy: "Privacy",
  terms: "Terms",
  trust: "Trust",
};

export const LEGAL_GROUP_ORDER: readonly LegalGroup[] = ["privacy", "terms", "trust"];

const SLUGS: ReadonlySet<string> = new Set(LEGAL_DOCUMENTS.map((d) => d.slug));

export function isLegalSlug(value: unknown): value is LegalSlug {
  return typeof value === "string" && SLUGS.has(value);
}

export function legalDocumentEntry(slug: LegalSlug): LegalDocumentEntry {
  // The catalogue is closed and `slug` is typed against it, so this always
  // finds one; the throw is for a caller that cast its way past the type.
  const entry = LEGAL_DOCUMENTS.find((d) => d.slug === slug);
  if (!entry) throw new Error(`unknown legal document slug: ${slug}`);
  return entry;
}

export function legalDocumentHref(slug: LegalSlug): `/legal/${LegalSlug}` {
  return `/legal/${slug}`;
}

/** The root every public legal page lives under -- the one prefix
 *  lib/supabase/middleware.ts's PUBLIC_PATHS adds for this feature. */
export const LEGAL_ROOT = "/legal";
