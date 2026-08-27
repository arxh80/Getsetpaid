import { redirect } from "next/navigation";
import { getCurrentUser, getMemberships } from "@/lib/auth";
import { readCurrentOrgIdCookie } from "@/lib/org/current-org";
import { resolveTargetMembership } from "@/lib/org/resolve";

// The post-authentication hub.
//
// Every emailed link, OAuth return and sign-in eventually lands here, and it
// decides where a user actually belongs. Doing that in ONE place matters: the
// alternative is each of the five entry points guessing, and drifting.
//
// The order is the priority order:
//   1. no session            -> sign in (middleware normally catches this first)
//   2. an active workspace   -> straight into it, no interstitial
//   3. a pending invitation  -> the invite screen
//   4. nothing at all        -> create a workspace
//
// Active membership is checked BEFORE pending invitations on purpose. Someone
// who already works in a workspace and is invited to a second one should land
// in the one they use, not be interrupted by an invitation they can accept
// whenever they like.
export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const memberships = await getMemberships();

  const active = memberships.filter((m) => m.status === "active");
  if (active.length > 0) {
    // Task 8: prefer the workspace the user last viewed over arbitrary query
    // order, for the multi-org case this used to just take active[0] for.
    // readCurrentOrgIdCookie() is client-supplied and untrusted -- see
    // lib/org/resolve.ts's resolveTargetMembership(), the only thing that
    // ever reads its return value, and only ever to pick among `active`
    // (already RLS-verified, above). A cookie naming a stale, revoked or
    // foreign org id resolves through the exact same "not found -> first
    // active membership" path this redirect always took before the cookie
    // existed -- never a 500, never a hint about whether the named org
    // exists at all.
    const rememberedOrgId = await readCurrentOrgIdCookie();
    const target = resolveTargetMembership(rememberedOrgId, active);
    if (target?.organisation.slug) {
      redirect(`/${target.organisation.slug}`);
    }
  }

  if (memberships.some((m) => m.status === "invited")) {
    redirect("/invites");
  }

  redirect("/onboarding");
}
