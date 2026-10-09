import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the data subject request queue.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM -- see app/(app)/super/organisations/
// loading.tsx's header for the mechanism: notFound() streams the not-found
// document only when it runs below a route's own loading.tsx boundary.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-wrap items-end gap-4 border-y border-rule py-4">
        <Bone className="h-11 flex-1 basis-64" />
        <Bone className="h-11 basis-48" />
        <Bone className="h-11 basis-56" />
        <Bone className="h-11 w-24" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-4 border-t border-rule pt-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 border-b border-rule pb-4">
            <Bone className="h-6 w-96 max-w-full" />
            <Bone className="h-5 w-full max-w-prose" />
            <Bone className="h-16 w-full max-w-prose" />
            <Bone className="h-11 w-64" />
          </div>
        ))}
      </div>
    </div>
  );
}
