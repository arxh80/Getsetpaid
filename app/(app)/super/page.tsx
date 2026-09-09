import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";

// The route area's index.
//
// IT USED TO BE A redirect() TO /super/audit-log, and that was the honest
// rendering of "one destination" while Phase 7 Task 1's audit log viewer was
// the only surface here. Task 2 added a second (impersonation), at which point
// a redirect makes the new page reachable only by typing its URL -- so this is
// now the real landing page the old file's own comment anticipated ("A later
// Phase 7 task that adds a second surface ... turns this into a real landing
// page"). Later tasks add their rows to the same list.
//
// generateMetadata(), NOT a static `export const metadata`, for the reason
// app/(app)/super/audit-log/page.tsx documents: a static title is evaluated
// regardless of what the body renders, so it would carry "Superuser" into the
// streamed refusal a non-superuser receives and become an enumeration oracle.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Superuser · GetSetPaid" };
}

const SURFACES: readonly { href: string; label: string; blurb: string }[] = [
  {
    href: "/super/audit-log",
    label: "Audit log",
    blurb:
      "Every high-value action recorded across every organisation, searchable by organisation, actor, action and date. Viewing it is itself audited.",
  },
  {
    href: "/super/impersonation",
    label: "Impersonation",
    blurb:
      "Break-glass, read-only support access to one workspace, only after that workspace's own Owner or Admin accepts, time-boxed and fully audited.",
  },
  {
    href: "/super/organisations",
    label: "Organisations",
    blurb:
      "Suspend, close and reopen a workspace. Soft-delete only, every transition reasoned and audited, and every one of them reversible.",
  },
  {
    href: "/super/billing",
    label: "Billing overrides",
    blurb:
      "Time-boxed, audited exceptions to a workspace's tier, seat count or feature flags. Never a permanent edit — every override auto-reverts when it expires.",
  },
];

export default async function SuperuserIndexPage() {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header for why
  // the gate lives here rather than in the layout.
  if (!(await isSuperuser())) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">
          Platform
        </h1>
        <p className="max-w-prose text-base text-ink-muted">
          Operator surfaces. None of them shows the content of a tenant’s
          records — that is only reachable through an accepted, time-boxed
          impersonation session.
        </p>
      </div>

      <ul className="flex flex-col border-t border-rule">
        {SURFACES.map((surface) => (
          <li key={surface.href} className="border-b border-rule py-4">
            <Link
              href={surface.href}
              className="text-base font-semibold text-primary underline underline-offset-4 hover:text-ink"
            >
              {surface.label}
            </Link>
            <p className="mt-1 max-w-prose text-base text-ink-muted">
              {surface.blurb}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
