import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for duplicates/[candidateId]/page.tsx: header with
// intro, then the bordered three-column field-by-field comparison table
// (Field / keep / duplicate). The wrapping card is the page's own
// `overflow-x-auto border border-rule bg-surface`; the table bones come from
// ListSkeleton with its announcement suppressed -- LoadingStatus already
// carries it for this surface. See components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Bone className="h-6 w-48" />
        <div className="overflow-x-auto border border-rule bg-surface p-4">
          <ListSkeleton columns={3} rows={6} announce={false} />
        </div>
      </div>
    </div>
  );
}
