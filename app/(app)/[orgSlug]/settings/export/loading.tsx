import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for [orgSlug]/settings/export/page.tsx: the h1 + lede,
// the outcome region, the "what is in it" paragraphs, the start control (a
// step-up prompt or a button) and the list of this reader's own exports.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-80 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-6 w-40" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-12 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <Bone className="h-6 w-48" />
        <Bone className="h-11 w-64" />
      </div>
      <SectionSkeleton rows={2} divider={false} />
    </div>
  );
}
