import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { MeetingForm } from "@/components/crm/meeting-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/meetings/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `New meeting · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NewMeetingPage({ params }: PageProps<"/[orgSlug]/meetings/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_meetings");
  const basePath = `/${org.slug}/meetings`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Meetings
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">New meeting</h1>
        <p className="max-w-prose text-base text-ink-muted">
          A title and a start are required. Add the location, a video link, who
          is coming and any notes, and link it to the records it is about from
          its own page.
        </p>
      </div>

      {access.canWrite ? (
        <MeetingForm
          orgSlug={org.slug}
          values={{
            title: "",
            startsAt: "",
            endsAt: "",
            location: "",
            meetingUrl: "",
            attendees: "",
            notes: "",
            status: "scheduled",
          }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-meeting-blocked" />
      )}
    </div>
  );
}
