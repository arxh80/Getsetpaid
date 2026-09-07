import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadMeeting } from "@/lib/crm/queries";
import { MeetingForm } from "@/components/crm/meeting-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";
import { instantToLondonWallClock } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/meetings/[meetingId]/edit">): Promise<Metadata> {
  const { orgSlug, meetingId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadMeeting(org.id, meetingId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.title} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditMeetingPage({
  params,
}: PageProps<"/[orgSlug]/meetings/[meetingId]/edit">) {
  const { orgSlug, meetingId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadMeeting(org.id, meetingId),
    getCrmWriteAccess(org, "manage_meetings"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this meeting just now. Refresh the page to try again —
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const meeting = result.record;
  const basePath = `/${org.slug}/meetings`;
  if (meeting.deletedAt !== null) redirect(`${basePath}/${meeting.id}`);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/${meeting.id}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {meeting.title}
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Edit meeting</h1>
      </div>

      {access.canWrite ? (
        <MeetingForm
          orgSlug={org.slug}
          values={{
            id: meeting.id,
            title: meeting.title,
            startsAt: instantToLondonWallClock(meeting.startsAt),
            endsAt: meeting.endsAt === null ? "" : instantToLondonWallClock(meeting.endsAt),
            location: meeting.location ?? "",
            meetingUrl: meeting.meetingUrl ?? "",
            attendees: meeting.attendees ?? "",
            notes: meeting.notes ?? "",
            status: meeting.status,
          }}
          cancelHref={`${basePath}/${meeting.id}`}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-meeting-blocked" />
      )}
    </div>
  );
}
