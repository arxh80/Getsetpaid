import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for account/privacy/page.tsx: the h1 + lede, the
// marketing section (heading and chip, the notice, the state sentence, the
// quoted statement, the governing-page line and the one button), then the
// history list and the two explanatory sections. Outside any workspace, like
// /invites, so no eyebrow and no rail.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-80 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <Bone className="h-6 w-48" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-5 w-full max-w-prose" />
        <Bone className="h-12 w-full max-w-prose" />
        <Bone className="h-4 w-80 max-w-full" />
        <Bone className="h-11 w-60" />
      </div>
      <SectionSkeleton rows={2} divider={false} />
      <SectionSkeleton rows={1} divider={false} />
    </div>
  );
}
