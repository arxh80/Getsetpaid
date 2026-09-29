import {
  LoadingStatus,
  PageHeaderSkeleton,
  ToolbarSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the feedback list.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM -- app/(app)/super/layout.tsx's
// header: notFound() renders the streamed not-found document only when it runs
// below a route's own loading.tsx boundary. Without this file the page's
// isSuperuser() refusal would land as a literal 404, a different document
// from every other /super/* refusal and therefore an enumeration oracle.
//
// Header, the six-control filter strip, then row bones -- fewer than a real
// page renders, the loading-skeletons pass's convention.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <ToolbarSkeleton filters={5} />
      <div aria-hidden="true" className="flex flex-col border-t border-rule">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-3 border-b border-rule py-4">
            <Bone className="h-5 w-40" />
            <Bone className="h-4 w-72" />
            <Bone className="h-16 w-full max-w-prose" />
            <Bone className="h-11 w-56 self-end" />
          </div>
        ))}
      </div>
    </div>
  );
}
