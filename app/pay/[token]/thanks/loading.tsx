import { LoadingStatus } from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for pay/[token]/thanks/page.tsx: the h1 and one line.
export default function Loading() {
  return (
    <div className="flex max-w-prose flex-col gap-3">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-96 max-w-full" />
        <Bone className="h-5 w-full" />
      </div>
    </div>
  );
}
