import {
  LoadingStatus,
  PageHeaderSkeleton,
  SectionSkeleton,
  FieldSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for members/page.tsx, mirroring its four blocks
// (review finding I2): header (org-name eyebrow + h1, nothing else), the
// "In this workspace" ruled list and the "Invited" ruled list -- neither
// carries a top rule on the real page, so divider={false} -- then the
// max-w-md invite-form section behind its rule (h2 + intro line + email
// field + role select + full-width button). See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <PageHeaderSkeleton />
      <SectionSkeleton rows={4} divider={false} />
      <SectionSkeleton rows={1} divider={false} />
      <div
        aria-hidden="true"
        className="flex w-full max-w-md flex-col gap-5 border-t border-rule pt-8"
      >
        <div className="flex flex-col gap-2">
          <Bone className="h-6 w-40" />
          <Bone className="h-5 w-full" />
        </div>
        <FieldSkeleton />
        <FieldSkeleton />
        <Bone className="h-11 w-full" />
      </div>
    </div>
  );
}
