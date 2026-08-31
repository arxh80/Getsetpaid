import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { loadTask } from "@/lib/crm/queries";
import { TaskForm } from "@/components/crm/task-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";
import { Alert } from "@/components/ui/alert";
import { instantToLondonWallClock } from "@/lib/format/date";

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/tasks/[taskId]/edit">): Promise<Metadata> {
  const { orgSlug, taskId } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) return { title: "Not found · GetSetPaid" };
  const result = await loadTask(org.id, taskId);
  return {
    title:
      result.outcome === "found"
        ? `Edit ${result.record.title} · GetSetPaid`
        : "Not found · GetSetPaid",
  };
}

export default async function EditTaskPage({
  params,
}: PageProps<"/[orgSlug]/tasks/[taskId]/edit">) {
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
        nothing has been changed.
      </Alert>
    );
  }
  if (result.outcome === "missing") notFound();

  const task = result.record;
  const basePath = `/${org.slug}/tasks`;
  // A DELETED TASK IS NOT EDITABLE -- it is restored first. Send the user to the
  // record, where the Restore control is.
  if (task.deletedAt !== null) redirect(`${basePath}/${task.id}`);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link
            href={`${basePath}/${task.id}`}
            className="break-words text-primary underline underline-offset-4 hover:text-ink"
          >
            {task.title}
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Edit task</h1>
      </div>

      {access.canWrite ? (
        <TaskForm
          orgSlug={org.slug}
          values={{
            id: task.id,
            title: task.title,
            detail: task.detail ?? "",
            status: task.status,
            priority: task.priority,
            // Instants back to Europe/London wall clocks for the inputs.
            dueAt: task.dueAt === null ? "" : instantToLondonWallClock(task.dueAt),
            reminderAt: task.reminderAt === null ? "" : instantToLondonWallClock(task.reminderAt),
          }}
          cancelHref={`${basePath}/${task.id}`}
        />
      ) : (
        <WriteBlockedNote access={access} id="edit-task-blocked" />
      )}
    </div>
  );
}
