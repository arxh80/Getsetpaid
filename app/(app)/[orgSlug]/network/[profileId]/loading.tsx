import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for network/[profileId]/page.tsx: back link, profile
// name with its status chip, the short profile-card stack (headline, kind,
// location, website, email), then the Connect section. See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-4 w-32" />
        <div className="flex flex-wrap items-center gap-3">
          <Bone className="h-8 w-64 max-w-full" />
          <Bone className="h-5 w-20" />
        </div>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Bone className="h-5 w-72 max-w-full" />
        <Bone className="h-4 w-32" />
        <Bone className="h-4 w-40" />
        <Bone className="h-4 w-48" />
        <Bone className="h-4 w-44" />
      </div>
      <SectionSkeleton rows={1} />
    </div>
  );
}
