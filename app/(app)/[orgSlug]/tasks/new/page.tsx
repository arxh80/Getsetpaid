import { TaskForm } from "@/components/crm/task-form";
import { newRecordPage } from "@/components/crm/new-record-page";

const { generateMetadata, Page } = newRecordPage({
  segment: "tasks",
  backLabel: "Tasks",
  title: "New task",
  blurb: (
    <>
      Only a title is required. Set a due date and priority if it helps, and
      link the task to the records it is about from its own page.
    </>
  ),
  permissionKey: "manage_tasks",
  blockedId: "new-task-blocked",
  form: ({ org, basePath }) => (
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
  ),
});

export { generateMetadata };
export default Page;
