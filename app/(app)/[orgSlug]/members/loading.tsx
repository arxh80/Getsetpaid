import {
  LoadingStatus,
  PageHeaderSkeleton,
  SectionSkeleton,
  FieldSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for members/page.tsx: header, the "In this workspace"
// and "Invited" ruled lists, then the max-w-md invite form (one field, one
// role select, one button). See components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <PageHeaderSkeleton />
      <SectionSkeleton rows={4} />
      <SectionSkeleton rows={2} />
      <div
        aria-hidden="true"
        className="flex w-full max-w-md flex-col gap-5 border-t border-rule pt-6"
      >
        <Bone className="h-6 w-40" />
        <FieldSkeleton />
        <FieldSkeleton />
        <Bone className="h-11 w-32" />
      </div>
    </div>
  );
}
