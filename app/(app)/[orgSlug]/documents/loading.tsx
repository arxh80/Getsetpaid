import {
  PageHeaderSkeleton,
  ToolbarSkeleton,
} from "@/components/skeleton/page-skeletons";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for documents/page.tsx: header with intro, the
// bordered upload card (label, native file input, the scan notice, the
// Upload button -- components/crm/document-upload.tsx), the toolbar with its
// two filter selects, then the seven-column table. ListSkeleton carries the
// surface's one role="status" line. See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeaderSkeleton action={false} intro smallLink />
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 border border-rule bg-surface p-4"
      >
        <Bone className="h-4 w-24" />
        <Bone className="h-11 w-full" />
        <Bone className="h-4 w-3/4 max-w-prose" />
        <Bone className="h-11 w-24" />
      </div>
      <ToolbarSkeleton filters={2} />
      <ListSkeleton columns={7} />
    </div>
  );
}
