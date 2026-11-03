import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the legal-document editor.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM -- see app/(app)/super/organisations/
// loading.tsx's header for the mechanism: notFound() streams the not-found
// document only when it runs below a route's own loading.tsx boundary.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-2 border border-rule p-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Bone key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}
