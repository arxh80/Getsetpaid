import {
  LoadingStatus,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for invites/page.tsx, mirroring its three blocks
// after the header (review finding I2): "Waiting for you" (a ruled row with
// the accept action, no top rule), the account-setup section behind its
// rule, and the unheaded footer paragraph behind another. The header is h1 +
// a text-lg lede, no eyebrow -- this page sits outside any workspace. See
// components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-8">
      <LoadingStatus />
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Bone className="h-8 w-64 max-w-full" />
        <Bone className="h-6 w-full max-w-prose" />
      </div>
      <SectionSkeleton rows={1} divider={false} />
      <SectionSkeleton rows={1} />
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 border-t border-rule pt-8"
      >
        <Bone className="h-5 w-3/4 max-w-prose" />
      </div>
    </div>
  );
}
