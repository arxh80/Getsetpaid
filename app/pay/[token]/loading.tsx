import { LoadingStatus } from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for pay/[token]/page.tsx: the h1, the seller and amount
// lines, then the button.
export default function Loading() {
  return (
    <div className="flex max-w-prose flex-col gap-6">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-72 max-w-full" />
        <Bone className="h-5 w-56 max-w-full" />
        <Bone className="h-6 w-64 max-w-full" />
      </div>
      <Bone className="h-11 w-40" />
    </div>
  );
}
