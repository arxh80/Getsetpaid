import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { LegalSlug } from "./documents";

// The public read: the CURRENT PUBLISHED version of one legal document.
//
// Runs as whoever is asking -- `anon` for a signed-out visitor, their own
// `authenticated` session otherwise -- and both see exactly the same thing:
// `legal_documents_select_current_published` matches only status =
// 'published' rows, and the column grant (20260922000000) is these eight
// columns and no more. The explicit select list is not a style choice: a
// `select('*')` would be refused outright, because the reviewer's name and
// the attribution uuids are outside the grant.

export interface PublishedLegalDocument {
  readonly id: string;
  readonly slug: LegalSlug;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  /** A `date` column: YYYY-MM-DD, no timezone. */
  readonly effectiveDate: string;
  readonly publishedAt: string;
  /** Null means counsel has not reviewed this version: show the notice. */
  readonly counselReviewedAt: string | null;
}

export const PUBLISHED_COLUMNS =
  "id, slug, version, title, body, effective_date, published_at, counsel_reviewed_at";

interface Row {
  id: string;
  slug: LegalSlug;
  version: number;
  title: string;
  body: string;
  effective_date: string;
  published_at: string;
  counsel_reviewed_at: string | null;
}

/**
 * The current published version of `slug`, or null if there is none.
 *
 * FAILS LOUDLY on a query error rather than returning null: a legal page that
 * silently 404s during a database blip would tell a visitor the policy does
 * not exist. Every slug is seeded and nothing can unpublish, so null means a
 * genuinely missing row (a deployment without the seed migration), which the
 * page renders as not found.
 */
export const getPublishedLegalDocument = cache(
  async (slug: LegalSlug): Promise<PublishedLegalDocument | null> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("legal_documents")
      .select(PUBLISHED_COLUMNS)
      .eq("slug", slug)
      .maybeSingle<Row>();
    if (error) {
      throw new Error(`[legal] could not read the published ${slug} document: ${error.message}`);
    }
    if (!data) return null;
    return {
      id: data.id,
      slug: data.slug,
      version: data.version,
      title: data.title,
      body: data.body,
      effectiveDate: data.effective_date,
      publishedAt: data.published_at,
      counselReviewedAt: data.counsel_reviewed_at,
    };
  },
);
