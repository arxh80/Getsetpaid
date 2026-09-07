import {
  LoadingStatus,
  PageHeaderSkeleton,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for settings/custom-fields/page.tsx: header with
// intro, the tab strip of h-11 entity pills, then the editor area's bones.
// See components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div
        aria-hidden="true"
        className="flex flex-wrap gap-2 border-b border-rule pb-3"
      >
        {/* Literal class names, never `w-${n}` -- Tailwind's scanner only
            sees complete strings in the source. */}
        {["w-28", "w-24", "w-20", "w-24", "w-20", "w-28", "w-24"].map(
          (w, i) => (
            <Bone key={i} className={`h-11 ${w}`} />
          ),
        )}
      </div>
      <SectionSkeleton rows={3} />
    </div>
  );
}
