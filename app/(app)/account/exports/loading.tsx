import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for account/exports/page.tsx: the h1 + lede, the
// outcome region, the "what is in it" paragraphs, the start button and the
// list of previous exports. Outside any workspace, like /account/privacy, so
// no eyebrow and no rail.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-72 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-6 w-40" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-10 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <Bone className="h-6 w-48" />
        <Bone className="h-11 w-64" />
      </div>
      <SectionSkeleton rows={2} divider={false} />
    </div>
  );
}
