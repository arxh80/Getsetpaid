import {
  LoadingStatus,
  FieldSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for onboarding/page.tsx: the max-w-md centred column
// -- h1, text-lg lede, the create-organisation form's bones. See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-7">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-56 max-w-full" />
        <Bone className="h-6 w-full" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <FieldSkeleton />
        <FieldSkeleton />
        <Bone className="h-11 w-40" />
      </div>
    </div>
  );
}
