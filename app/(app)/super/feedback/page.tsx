import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isSuperuser } from "@/lib/admin/superuser";
import { fetchFeedbackPage, parseFeedbackParams } from "@/lib/feedback/list";
import type { RawSearchParams } from "@/lib/list/params";
import { FeedbackList } from "@/components/admin/feedback-list";

// PHASE 7 TASK 6: the founder's feedback list. CLAUDE.md § In-app feedback:
// "a dedicated Feedback list -- filterable by org, category, and date -- with
// a status per item (New / Read / Actioned / Archived) the founder updates
// manually. Separate UI from the audit log viewer."
//
// THIS PAGE SHOWS USER-ENTERED CONTENT ON PURPOSE. The feedback message is the
// product; it is rendered inert (text, pre-wrap, never HTML). The screenshot
// is the one deliberate exception to the no-direct-tenant-data rule and is
// NOT rendered here: it is a link to the audited route handler, so every view
// is a recorded act (lib/feedback/screenshot.ts).
//
// generateMetadata(), NOT a static export -- the enumeration-oracle fix every
// /super/* page carries: a static title would carry "Superuser" into the
// streamed refusal a non-superuser receives.
export async function generateMetadata(): Promise<Metadata> {
  if (!(await isSuperuser())) return { title: "Not found · GetSetPaid" };
  return { title: "Feedback · Superuser · GetSetPaid" };
}

const BASE_PATH = "/super/feedback";

export default async function FeedbackPage({
  searchParams,
}: PageProps<"/super/feedback">) {
  // STREAMED, NOT LITERAL -- see app/(app)/super/layout.tsx's header.
  if (!(await isSuperuser())) notFound();

  const raw = (await searchParams) as RawSearchParams;
  const params = parseFeedbackParams(raw);
  const page = await fetchFeedbackPage(params);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="tracking-display text-3xl font-extrabold text-ink">Feedback</h1>
        <p className="max-w-prose text-base text-ink-muted">
          What people sent from the “Feedback” control, newest first, a page
          at a time. Every submission is identified and audited; a screenshot
          is only ever opened through a link that records who opened it and
          when. Rows older than two years are no longer shown.
        </p>
      </div>
      <FeedbackList page={page} params={params} raw={raw} basePath={BASE_PATH} />
    </div>
  );
}
