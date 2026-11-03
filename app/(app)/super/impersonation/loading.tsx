import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for the impersonation page: header with intro, the
// request form's two fields and button, then the sessions list.
//
// IT MUST EXIST FOR THE REFUSAL TO STREAM. app/(app)/super/layout.tsx's
// header explains the mechanism: notFound() streams the not-found document
// only when it runs BELOW a route's own loading.tsx boundary. Without this
// file the non-superuser refusal at /super/impersonation would be a literal
// 404 while /super/audit-log's stayed a streamed 200 -- two different
// refusals for the same class of caller, which is the parity DESIGN.md
// § Error pages asks not to break.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex max-w-prose flex-col gap-4">
        <Bone className="h-6 w-40" />
        <Bone className="h-11 w-full" />
        <Bone className="h-24 w-full" />
        <Bone className="h-11 w-36" />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-32" />
        <Bone className="h-16 w-full" />
        <Bone className="h-16 w-full" />
      </div>
    </div>
  );
}
