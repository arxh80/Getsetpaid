import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the platform health view.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM. app/(app)/super/layout.tsx's header
// explains the mechanism at length: notFound() renders the streamed not-found
// document (HTTP 200, the identical app/(app)/not-found.tsx body) only when it
// runs BELOW a route's own loading.tsx Suspense boundary. Without this file
// the page's isSuperuser() refusal would land as a literal 404 -- a different
// document from every other /super/* refusal, and therefore an enumeration
// oracle that says "this route is special" by the shape of its no.
//
// The bones mirror the real page's own rhythm -- header, four stat sections,
// then the alert list -- so the swap does not jump. Deliberately fewer rows
// than the page renders: a skeleton promises a shape, not a row count, and
// over-reserving is the more visible error (the loading-skeletons pass'
// convention).
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex max-w-prose flex-col gap-3">
        <Bone className="h-4 w-72" />
      </div>
      {[0, 1, 2, 3].map((section) => (
        <div
          key={section}
          aria-hidden="true"
          className="flex max-w-prose flex-col gap-3 border-t border-rule pt-8"
        >
          <Bone className="h-7 w-56" />
          <Bone className="h-9 w-full" />
          <Bone className="h-9 w-full" />
          <Bone className="h-9 w-full" />
        </div>
      ))}
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-full max-w-prose" />
        <Bone className="h-20 w-full" />
        <Bone className="h-20 w-full" />
      </div>
    </div>
  );
}
