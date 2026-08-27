import { redirect } from "next/navigation";
import { getCurrentUser, getMemberships } from "@/lib/auth";

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
  if (active.length > 0 && active[0].organisation.slug) {
    redirect(`/${active[0].organisation.slug}`);
  }

  if (memberships.some((m) => m.status === "invited")) {
    redirect("/invites");
  }

  redirect("/onboarding");
}
