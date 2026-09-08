import { notFound, redirect } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";

// The route area's index. Phase 7 Task 1 ships exactly one superuser
// surface (the audit log viewer), so there is nothing to index yet -- this
// page's whole job is the gate check, streamed (see app/(app)/super/
// layout.tsx's header for why the check lives here and not there), plus a
// redirect to the one page that exists. A later Phase 7 task that adds a
// second surface (impersonation, org lifecycle, billing, health, feedback)
// turns this into a real landing page; until then a redirect is the honest
// rendering of "one destination".
export default async function SuperuserIndexPage() {
  if (!(await isSuperuser())) notFound();
  redirect("/super/audit-log");
}
