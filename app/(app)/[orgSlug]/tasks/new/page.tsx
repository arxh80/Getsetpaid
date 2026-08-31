import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth";
import { getCrmWriteAccess } from "@/lib/crm/write-access";
import { TaskForm } from "@/components/crm/task-form";
import { WriteBlockedNote } from "@/components/crm/write-gate";

// New task. The ROUTE is gated, not only the button that leads to it: the
// INSERT policy (20260902011000) refuses the write from any client, and this
// checks before rendering the form. Neither is the other's substitute.

export async function generateMetadata({
  params,
}: PageProps<"/[orgSlug]/tasks/new">): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  return {
    title: org ? `New task · ${org.name} · GetSetPaid` : "Not found · GetSetPaid",
  };
}

export default async function NewTaskPage({ params }: PageProps<"/[orgSlug]/tasks/new">) {
  const { orgSlug } = await params;
  const org = await getCurrentOrg(orgSlug);
  if (!org) notFound();

  const access = await getCrmWriteAccess(org, "manage_tasks");
  const basePath = `/${org.slug}/tasks`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          <Link href={basePath} className="text-primary underline underline-offset-4 hover:text-ink">
            Tasks
          </Link>
        </p>
        <h1 className="tracking-display text-3xl font-extrabold text-ink">New task</h1>
        <p className="max-w-prose text-base text-ink-muted">
          Only a title is required. Set a due date and priority if it helps, and
          link the task to the records it is about from its own page.
        </p>
      </div>

      {access.canWrite ? (
        <TaskForm
          orgSlug={org.slug}
          values={{
            title: "",
            detail: "",
            // The column defaults too; the form states the same two rather than
            // an empty option.
            status: "open",
            priority: "normal",
            dueAt: "",
            reminderAt: "",
          }}
          cancelHref={basePath}
        />
      ) : (
        <WriteBlockedNote access={access} id="new-task-blocked" />
      )}
    </div>
  );
}
