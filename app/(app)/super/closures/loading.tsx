import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for /super/closures: header with intro, then one
// closed-workspace row (metadata strip and the two decision forms).
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM -- app/(app)/super/layout.tsx's
// header has the mechanism, and organisations/loading.tsx the same note.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-5 border-t border-rule pt-6">
        <Bone className="h-6 w-64" />
        <Bone className="h-12 w-full max-w-3xl" />
        <div className="grid gap-8 lg:grid-cols-2">
          <Bone className="h-48 w-full" />
          <Bone className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}
