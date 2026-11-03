import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for account/data-requests/page.tsx: the h1 + lede and
// the legal-page link, the no-account notice, the "Make a request" section
// (two radio groups of six and two, the textarea and the button), then the
// list of the person's own requests. Outside any workspace, like
// /account/privacy, so no eyebrow and no rail.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-96 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
        <Bone className="h-5 w-80 max-w-full" />
      </div>
      <Bone className="h-16 w-full max-w-prose" />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Bone className="h-6 w-48" />
        <Bone className="h-7 w-64" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Bone key={row} className="h-12 w-full max-w-prose" />
        ))}
        <Bone className="h-7 w-64" />
        {[0, 1].map((row) => (
          <Bone key={row} className="h-12 w-full max-w-prose" />
        ))}
        <Bone className="h-32 w-full max-w-prose" />
        <Bone className="h-11 w-48" />
      </div>
      <SectionSkeleton rows={2} divider={false} />
    </div>
  );
}
