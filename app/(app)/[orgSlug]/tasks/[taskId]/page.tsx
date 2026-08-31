import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import {
  DELETED_RECORD_EXPLANATION,
  getCrmWriteAccess,
} from "@/lib/crm/write-access";
import { loadLinkOptionGroups, loadLinksFor, loadTask } from "@/lib/crm/queries";
import { TaskStatusChip } from "@/components/crm/task-status-chip";
import { PriorityChip } from "@/components/crm/priority-chip";
import { EntityLinkPicker } from "@/components/crm/entity-link-picker";
import { deleteTaskAction, restoreTaskAction } from "@/lib/crm/tasks";
import { Alert } from "@/components/ui/alert";
import { DeleteRecordForm, RestoreRecordForm } from "@/components/crm/delete-restore";
import { SecondaryRecordAction, WriteBlockedNote } from "@/components/crm/write-gate";
import { formatDateTime } from "@/lib/format/date";

// One task, with the entity-link picker: the CRM records it is linked to, and
// a control to add or remove one. A DELETED task renders (loadTask does not
// filter deleted_at) so the restore control is on the record itself.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/tasks/[taskId]">): Promise<Metadata> {
  const { orgSlug, taskId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadTask(org.id, taskId);
  return {
    title:
      result.outcome === "found"
        ? `${result.record.title} · Tasks · ${org.name} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

const MANAGE_NOTE = "task-manage-blocked";

export default async function TaskDetailPage({
  params,
}: PageProps<"/[orgSlug]/tasks/[taskId]">) {
  const { orgSlug, taskId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const [result, access] = await Promise.all([
    loadTask(org.id, taskId),
    getCrmWriteAccess(org, "manage_tasks"),
  ]);

  if (result.outcome === "unavailable") {
    return (
      <Alert tone="error">
        We couldn’t load this task just now. Refresh the page to try again —
        nothing has been deleted.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const task = result.record;
  const basePath = `/${org.slug}/tasks`;
  const deleted = task.deletedAt !== null;
  const pickerBlocked = deleted ? DELETED_RECORD_EXPLANATION : access.canWrite ? null : access.explanation;

  const [links, optionGroups] = await Promise.all([
    loadLinksFor("tasks", org.id, task.id),
    pickerBlocked === null ? loadLinkOptionGroups(org.id) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Tasks
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold break-words text-ink">
          {task.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <TaskStatusChip status={task.status} />
          <PriorityChip priority={task.priority} />
        </div>
      </div>

      {deleted ? (
        <Alert tone="info">
          {DELETED_RECORD_EXPLANATION} It was deleted on{" "}
          <time dateTime={task.deletedAt!} className="tabular-nums">
            {formatDateTime(task.deletedAt!)}
          </time>
          .
        </Alert>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <Detail label="Due">
          {task.dueAt === null ? (
            <Absent />
          ) : (
            <time dateTime={task.dueAt} className="tabular-nums">
              {formatDateTime(task.dueAt)}
            </time>
          )}
        </Detail>
        <Detail label="Reminder">
          {task.reminderAt === null ? (
            <Absent />
          ) : (
            <time dateTime={task.reminderAt} className="tabular-nums">
              {formatDateTime(task.reminderAt)}
            </time>
          )}
        </Detail>
        <Detail label="Completed">
          {task.completedAt === null ? (
            <Absent />
          ) : (
            <time dateTime={task.completedAt} className="tabular-nums">
              {formatDateTime(task.completedAt)}
            </time>
          )}
        </Detail>
        <Detail label="Added">
          <time dateTime={task.createdAt} className="tabular-nums">
            {formatDateTime(task.createdAt)}
          </time>
        </Detail>
      </dl>

      {task.detail ? (
        <section className="flex flex-col gap-3 border-t border-rule pt-6">
          <h2 className="text-xl font-bold text-ink">Details</h2>
          <p className="max-w-prose text-base break-words whitespace-pre-line text-ink">
            {task.detail}
          </p>
        </section>
      ) : null}

      <EntityLinkPicker
        orgSlug={org.slug}
        parentTable="tasks"
        parentId={task.id}
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
                href={`${basePath}/${task.id}/edit`}
                label="Edit task"
                describedBy={MANAGE_NOTE}
              />
            </div>
            <DeleteRecordForm
              action={deleteTaskAction}
              hiddenFields={{ orgSlug: org.slug, taskId: task.id }}
              label="Delete task"
              question={`Delete ${task.title}? It comes out of the tasks list. Its links stay with it and can be restored from Tasks › Deleted.`}
              blocked={!access.canWrite}
              describedBy={MANAGE_NOTE}
            />
          </>
        ) : (
          <RestoreRecordForm
            action={restoreTaskAction}
            hiddenFields={{ orgSlug: org.slug, taskId: task.id }}
            label="Restore task"
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
