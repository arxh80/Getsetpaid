import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the billing/feature-overrides page.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM -- see app/(app)/super/organisations/
// loading.tsx's header for the mechanism: notFound() streams the not-found
// document only when it runs below a route's own loading.tsx boundary.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex max-w-prose flex-col gap-4">
        <Bone className="h-6 w-56" />
        <Bone className="h-11 w-full" />
        <Bone className="h-11 w-full" />
        <Bone className="h-11 w-full" />
        <Bone className="h-24 w-full" />
        <Bone className="h-11 w-48" />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-64" />
        <Bone className="h-20 w-full" />
      </div>
      <div aria-hidden="true" className="flex max-w-prose flex-col gap-4">
        <Bone className="h-6 w-56" />
        <Bone className="h-11 w-full" />
        <Bone className="h-11 w-full" />
        <Bone className="h-24 w-full" />
        <Bone className="h-11 w-48" />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-64" />
        <Bone className="h-20 w-full" />
      </div>
    </div>
  );
}
