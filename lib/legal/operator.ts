import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isLegalSlug, type LegalSlug } from "./documents";

// The superuser's read of every version, through
// public.operator_legal_document_versions() -- the only path to a draft, a
// superseded version or the reviewer's name. The RPC refuses (42501) anyone
// who is not the allowlisted superuser at aal2, so this module decides
// nothing: app/(app)/super/legal/page.tsx's isSuperuser() decides whether to
// render, and the database decides what is returned.

export type LegalVersionStatus = "draft" | "published" | "superseded";

export interface OperatorLegalVersion {
  readonly id: string;
  readonly slug: LegalSlug;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly effectiveDate: string;
  readonly status: LegalVersionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly supersededAt: string | null;
  readonly counselReviewedAt: string | null;
  readonly counselReviewer: string | null;
}

interface Row {
  id: string;
  slug: string;
  version: number;
  title: string;
  body: string;
  effective_date: string;
  status: LegalVersionStatus;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  superseded_at: string | null;
  counsel_reviewed_at: string | null;
  counsel_reviewer: string | null;
}

export type OperatorLegalRead =
  | { readonly ok: true; readonly versions: readonly OperatorLegalVersion[] }
  | { readonly ok: false };

/** Every version (newest first within a slug), or of one slug. */
export async function listOperatorLegalVersions(
  slug: LegalSlug | null = null,
): Promise<OperatorLegalRead> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("operator_legal_document_versions", {
    p_slug: slug,
  });
  if (error) {
    console.error("[legal] operator_legal_document_versions() failed:", error.message);
    return { ok: false };
  }
  const versions = ((data ?? []) as Row[])
    // A slug the app does not know (the CHECK and the catalogue disagree) is
    // dropped here rather than crashing the page; the integration test that
    // binds the two is where that disagreement goes red.
    .filter((row): row is Row & { slug: LegalSlug } => isLegalSlug(row.slug))
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      version: row.version,
      title: row.title,
      body: row.body,
      effectiveDate: row.effective_date,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      supersededAt: row.superseded_at,
      counselReviewedAt: row.counsel_reviewed_at,
      counselReviewer: row.counsel_reviewer,
    }));
  return { ok: true, versions };
}
