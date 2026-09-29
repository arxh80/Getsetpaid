import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for support-access/page.tsx: header with intro, then
// the three stacked sections (Waiting for you, Open right now, History), the
// last two behind top rules. One announcement for the surface.
//
// IT IS ALSO WHAT MAKES THE REFUSAL STREAM: the page's notFound() for a
// member without manage_organisation has to run below a loading boundary to
// produce the streamed not-found contract rather than a literal 404 (see
// DESIGN.md § Error pages and the loading-skeletons pass).
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Bone className="h-6 w-40" />
        <Bone className="h-20 w-full" />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-36" />
        <Bone className="h-20 w-full" />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-24" />
        <Bone className="h-16 w-full" />
      </div>
    </div>
  );
}
