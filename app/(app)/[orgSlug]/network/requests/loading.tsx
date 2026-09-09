import {
  LoadingStatus,
  PageHeaderSkeleton,
} from "@/components/skeleton/page-skeletons";
import { ListSkeleton } from "@/components/list/list-skeleton";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for network/requests/page.tsx: header with intro,
// then the two stacked four-column tables ("Received", then "Sent" behind a
// top rule). One announcement for the surface (LoadingStatus); both tables'
// own lines are suppressed. See components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Bone className="h-6 w-32" />
        <ListSkeleton columns={4} rows={4} announce={false} />
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-4 border-t border-rule pt-8"
      >
        <Bone className="h-6 w-24" />
        <ListSkeleton columns={4} rows={4} announce={false} />
      </div>
    </div>
  );
}
