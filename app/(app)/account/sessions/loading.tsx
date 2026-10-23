import { LoadingStatus } from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for account/sessions/page.tsx: the h1 + lede, then the
// "What happens" heading, its four points and the button. Outside any
// workspace, like the other /account pages, so no eyebrow and no rail.
export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-80 max-w-full" />
        <Bone className="h-12 w-full max-w-prose" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Bone className="h-6 w-40" />
        <Bone className="h-6 w-full max-w-prose" />
        <Bone className="h-6 w-full max-w-prose" />
        <Bone className="h-6 w-full max-w-prose" />
        <Bone className="h-6 w-full max-w-prose" />
        <Bone className="h-11 w-56" />
      </div>
    </div>
  );
}
