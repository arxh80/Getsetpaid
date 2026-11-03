import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for account/erase/page.tsx: the h1 + lede, the outcome
// region, the two "what goes / what stays" lists, the confirmation field and
// its button, and the list of what has been asked for. Outside any workspace,
// like /account/exports, so no eyebrow and no rail.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-80 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-6 w-48" />
        <Bone className="h-10 w-full max-w-prose" />
        <Bone className="h-10 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-6 w-56" />
        <Bone className="h-10 w-full max-w-prose" />
        <Bone className="h-10 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-6 w-32" />
        <Bone className="h-11 w-full max-w-prose" />
        <Bone className="h-11 w-48" />
      </div>
      <SectionSkeleton rows={2} divider={false} />
    </div>
  );
}
