import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for invites/page.tsx: h1 and its text-lg lede (no
// eyebrow -- this page sits outside any workspace), then the "Waiting for
// you" ruled list and the account-setup section. See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-64 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <SectionSkeleton rows={2} />
      <SectionSkeleton rows={1} />
    </div>
  );
}
