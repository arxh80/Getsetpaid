import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { MARKETING_EMAIL } from "./catalogue";

// ===========================================================================
// THE CHECK EVERY MARKETING SENDER MUST CALL -- WRITTEN BEFORE THE SENDER.
// ===========================================================================
// GetSetPaid sends no marketing email today (lib/email/send.ts is
// transactional only). PECR requires prior consent for marketing email to an
// individual, so the day a marketing sender is written it must ask this, per
// recipient, immediately before sending -- and
// tests/unit/consent/marketing-sender-census.test.ts fails for any module
// that imports the email sender without being on the transactional list or
// calling `assertMarketingConsent`.
//
// It takes the CLIENT as an argument rather than importing one. A sender runs
// with no session, so it will hold the service-role table client
// (lib/supabase/service.ts), whose importers are themselves censused; and
// `public.consent_is_granted()` is executable by `service_role` ALONE, so a
// user session cannot probe anybody's consent through this.
//
// FAILS CLOSED. No record is no consent, and an error is no consent: a
// database blip must cost a marketing email, never send one.
//
// A GRANT SURVIVES A NEW VERSION OF THE MARKETING PAGE (DECISIONS-QUEUE,
// Task 2). Re-consent on a material change is a deliberate act -- publish the
// new version, then ask again -- rather than something this check infers.

export async function hasMarketingConsent(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("consent_is_granted", {
    p_user_id: userId,
    p_purpose: MARKETING_EMAIL.purpose,
  });
  if (error) {
    console.error("[consent] marketing consent check failed; treating as not granted:", error.message);
    return false;
  }
  return data === true;
}

export class MarketingConsentMissingError extends Error {
  constructor(userId: string) {
    super(`marketing email refused: user ${userId} has not agreed to marketing email`);
    this.name = "MarketingConsentMissingError";
  }
}

/** Throws unless `userId` currently agrees to marketing email. Call it per
 *  recipient, immediately before each send -- never from a cached list. */
export async function assertMarketingConsent(
  client: SupabaseClient,
  userId: string,
): Promise<void> {
  if (!(await hasMarketingConsent(client, userId))) {
    throw new MarketingConsentMissingError(userId);
  }
}
