import { ListPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton, mirroring app/(app)/super/audit-log/page.tsx's
// frame: a heading, the five-field filter strip, then a seven-column table.
// No "New" action slot (nothing on this page is written by a form) and no
// "Deleted…" small-link line (audit_events has no soft delete -- it is
// append-only).
export default function Loading() {
  return <ListPageSkeleton columns={7} filters={5} action={false} smallLink={false} />;
}
