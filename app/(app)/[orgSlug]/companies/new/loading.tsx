import {
  LoadingStatus,
  PageHeaderSkeleton,
  FieldSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for companies/new/page.tsx. The company form is ONE
// text field plus a bordered fieldset of six company-type checkbox rows --
// not a stack of plain inputs (review finding I2) -- then the submit row.
// See components/skeleton/page-skeletons.tsx for the vocabulary.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton intro />
      <div aria-hidden="true" className="flex flex-col gap-5">
        <FieldSkeleton />
        <div className="flex flex-col gap-4 border border-rule p-5">
          <Bone className="h-4 w-12" />
          <Bone className="h-4 w-3/4 max-w-prose" />
          {["w-24", "w-32", "w-20", "w-28", "w-24", "w-36"].map((w, i) => (
            <div key={i} className="flex min-h-11 items-center gap-3">
              <Bone className="h-5 w-5" />
              <Bone className={`h-4 ${w}`} />
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Bone className="h-11 w-32" />
          <Bone className="h-5 w-16" />
        </div>
      </div>
    </div>
  );
}
