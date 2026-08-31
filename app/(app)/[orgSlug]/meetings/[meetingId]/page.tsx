import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import { loadLinkOptionGroups, loadLinksFor, loadMeeting } from "@/lib/crm/queries";
import { MeetingStatusChip } from "@/components/crm/task-status-chip";
import { EntityLinkPicker } from "@/components/crm/entity-link-picker";
import { deleteMeetingAction, restoreMeetingAction } from "@/lib/crm/tasks";
import { Alert } from "@/components/ui/alert";
import { DeleteRecordForm, RestoreRecordForm } from "@/components/crm/delete-restore";
import { SecondaryRecordAction, WriteBlockedNote } from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/meetings/[meetingId]">): Promise<Metadata> {
  const { orgSlug, meetingId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadMeeting(org.id, meetingId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.title} · Meetings · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

const MANAGE_NOTE = "meeting-manage-blocked";

export default async function MeetingDetailPage({
  params,
}: PageProps<"/[orgSlug]/meetings/[meetingId]">) {
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
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const meeting = result.record;
  const basePath = `/${org.slug}/meetings`;
  const deleted = meeting.deletedAt !== null;
  const pickerBlocked = deleted ? DELETED_RECORD_EXPLANATION : access.canWrite ? null : access.explanation;

  const [links, optionGroups] = await Promise.all([
    loadLinksFor("meetings", org.id, meeting.id),
    pickerBlocked === null ? loadLinkOptionGroups(org.id) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Meetings
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {meeting.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <MeetingStatusChip status={meeting.status} />
        </div>
      </div>

      {deleted ? (
        <Alert tone="info">
          {DELETED_RECORD_EXPLANATION} It was deleted on{" "}
          <time dateTime={meeting.deletedAt!} className="tabular-nums">
            {formatDateTime(meeting.deletedAt!)}
          </time>
          .
        </Alert>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Starts">
          <time dateTime={meeting.startsAt} className="tabular-nums">
            {formatDateTime(meeting.startsAt)}
          </time>
        </Detail>
        <Detail label="Ends">
          {meeting.endsAt === null ? (
            <Absent />
          ) : (
            <time dateTime={meeting.endsAt} className="tabular-nums">
              {formatDateTime(meeting.endsAt)}
            </time>
          )}
        </Detail>
        <Detail label="Location">
          {meeting.location ? <span className="break-words">{meeting.location}</span> : <Absent />}
        </Detail>
        <Detail label="Meeting link">
          {meeting.meetingUrlHref ? (
            <a
              href={meeting.meetingUrlHref}
              rel="noopener noreferrer nofollow"
              target="_blank"
              className="break-all text-primary underline underline-offset-4 hover:text-ink"
            >
              {meeting.meetingUrl}
            </a>
          ) : meeting.meetingUrl ? (
            // NOT A LINK: a stored non-http(s) value renders as inert text.
            <span translate="no" className="break-all">
              {meeting.meetingUrl}
            </span>
          ) : (
            <Absent />
          )}
        </Detail>
      </dl>

      {meeting.attendees ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Attendees</h2>
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {meeting.attendees}
          </p>
        </section>
      ) : null}

      {meeting.notes ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Notes</h2>
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {meeting.notes}
          </p>
        </section>
      ) : null}

      <EntityLinkPicker
        orgSlug={org.slug}
        parentTable="meetings"
        parentId={meeting.id}
        linked={links}
        optionGroups={optionGroups}
        disabledReason={pickerBlocked}
      />

      <section className="flex flex-col gap-4 border-t border-rule pt-6">
        <h2 className="text-xl font-bold text-ink">Manage</h2>
        <WriteBlockedNote access={access} id={MANAGE_NOTE} />
        {!deleted ? (
          <>
            <div className="flex flex-wrap items-start gap-4">
              <SecondaryRecordAction
                access={access}
                href={`${basePath}/${meeting.id}/edit`}
                label="Edit meeting"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteMeetingAction}
              hiddenFields={{ orgSlug: org.slug, meetingId: meeting.id }}
              label="Delete meeting"
              question={`Delete ${meeting.title}? It comes out of the meetings list. Its links stay with it and can be restored from Meetings › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreMeetingAction}
            hiddenFields={{ orgSlug: org.slug, meetingId: meeting.id }}
            label="Restore meeting"
            blocked={!access.canWrite}
            describedBy={MANAGE_NOTE}
          />
        )}
      </section>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold tracking-[0.04em] text-ink-muted uppercase">
        {label}
      </dt>
      <dd className="text-base break-words text-ink">{children}</dd>
    </div>
  );
}

function Absent() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}
