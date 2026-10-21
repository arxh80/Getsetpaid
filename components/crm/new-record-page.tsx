import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg, type CurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// THE CREATE FORM'S PAGE, ONCE.
//
// Nine of them -- contacts, companies, artists, agencies, venues, events,
// tasks, meetings, notes -- and measured line for line against the contacts
// copy the other eight were 65-77% identical. Every one resolved the org,
// 404'd, read the same permission, rendered the same breadcrumb/heading/blurb
// stack, and then chose between a form and the same refusal note.
//
// ===========================================================================
// THE ROUTE IS GATED, NOT ONLY THE BUTTON THAT LEADS TO IT
// ===========================================================================
// This is the reason the shape is worth keeping in one place. A user who types
// the URL, or follows a stale link, gets the same explanation rather than a
// form that submits and is refused -- and it is the SAME STRING the disabled
// button on the list page carries, because `getCrmWriteAccess()` produces
// both. Nine copies meant nine places that had to keep agreeing about that,
// and the failure mode (a form that renders, accepts typing and then refuses)
// is invisible to anything but a browser driven as a Read Only user.
//
// ===========================================================================
// THE FORM IS A RENDER FUNCTION, AND IT IS CALLED ONLY WHEN canWrite
// ===========================================================================
// Not a component plus a props bag. The nine forms take genuinely different
// props -- `values` alone ranges from `{name: ""}` to a nine-key object -- and
// a config that tried to describe them would be a worse copy of the JSX it
// replaced.
//
// Calling it lazily is load-bearing rather than tidy: `events/new` reads the
// venue picker, and a Read Only user gets the explanation and no picker, so
// there is no reason to read a hundred venues and their rooms for a page with
// no `<select>` on it. The slot returns a ReactNode, so that fetch can live in
// an async server component of the route's own -- without every other page
// awaiting something it does not use.

/** Everything one create page needs that another one's would differ on. */
export interface NewRecordPageConfig {
  /** Path segment of the LIST this returns to, e.g. "contacts". */
  readonly segment: string;
  /** The breadcrumb's text, e.g. "Contacts". */
  readonly backLabel: string;
  /** Heading and metadata title, e.g. "New contact". */
  readonly title: string;
  /** The paragraph under the heading. Per entity, never generated. */
  readonly blurb: ReactNode;
  /**
   * The permission this create is gated on. NOT derivable from the segment:
   * companies and agencies are gated on `manage_contacts`, because
   * 20260828121000 groups all three as "the relationship layer".
   */
  readonly permissionKey: string;
  /** The refusal note's id, e.g. "new-contact-blocked". */
  readonly blockedId: string;
  /** Rendered ONLY when the caller may write. See the header. */
  readonly form: (context: {
    readonly org: CurrentOrg;
    readonly basePath: string;
  }) => ReactNode;
}

/** The `generateMetadata` and page component for one create route. */
export function newRecordPage(config: NewRecordPageConfig) {
  async function generateMetadata({
    params,
  }: {
    params: Promise<{ orgSlug: string }>;
  }): Promise<Metadata> {
    const { orgSlug } = await params;
    const org = await getCurrentOrg(orgSlug);
    return {
      title: org
        ? `${config.title} · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
    };
  }

  async function Page({ params }: { params: Promise<{ orgSlug: string }> }) {
    const { orgSlug } = await params;
    const org = await getCurrentOrg(orgSlug);
    if (!org) notFound();

    const access = await getCrmWriteAccess(org, config.permissionKey);
    const basePath = `/${org.slug}/${config.segment}`;

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            <Link
              href={basePath}
              className="text-primary underline underline-offset-4 hover:text-ink"
            >
              {config.backLabel}
            </Link>
          </p>
          <h1 className="tracking-display text-3xl font-extrabold text-ink">
            {config.title}
          </h1>
          <p className="max-w-prose text-base text-ink-muted">{config.blurb}</p>
        </div>

        {access.canWrite ? (
          config.form({ org, basePath })
        ) : (
          <WriteBlockedNote access={access} id={config.blockedId} />
        )}
      </div>
    );
  }

  return { generateMetadata, Page };
}
