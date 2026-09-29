import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Skeleton for app/(app)/super/page.tsx. Since Phase 7 Task 2 that page is a
// real landing page (a list of the operator surfaces) rather than a gate and
// a redirect, so this is a header plus two rows rather than the bare
// announcement it used to be.
//
// It is still what makes the page's notFound() STREAM the not-found document
// instead of returning a literal 404 -- see app/(app)/super/layout.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-4 border-t border-rule pt-4">
        <Bone className="h-12 w-full" />
        <Bone className="h-12 w-full" />
      </div>
    </div>
  );
}
