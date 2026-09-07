import {
  LoadingStatus,
  PageHeaderSkeleton,
  SectionSkeleton,
} from "@/components/skeleton/page-skeletons";
import { Bone } from "@/components/skeleton/bone";

// Route-level skeleton for network/profiles/[profileId]/page.tsx (review
// finding I2 -- the first cut drew a plain 8-field form at roughly a quarter
// of the real page's height). The real editor
// (components/network/profile-editor.tsx) is: the publish summary, the
// always-shown Name field, then SEVEN publishable-field blocks on a ruled
// list -- each a label + control (bio, index 1, is the tall textarea)
// followed by a borderless "Who can see …" visibility fieldset of three
// radio rows -- then Save, then the page's own "Publish" and "Manage" ruled
// sections. See components/skeleton/page-skeletons.tsx.

/** One publishable-field block: label, control, visibility ladder. */
function EditorFieldSkeleton({ textarea = false }: { textarea?: boolean }) {
  return (
    <li className="flex flex-col gap-3 border-b border-rule pb-6">
      <div className="flex flex-col gap-2">
        <Bone className="h-4 w-24" />
        <Bone className={textarea ? "h-28 w-full" : "h-11 w-full"} />
      </div>
      <div className="flex flex-col gap-2">
        <Bone className="h-4 w-40" />
        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-4">
          {[0, 1, 2].map((r) => (
            <div key={r} className="flex min-h-11 items-center gap-2">
              <Bone className="h-4 w-4" />
              <Bone className="h-5 w-24" />
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <LoadingStatus />
      <PageHeaderSkeleton />
      {/* Publish summary line */}
      <Bone className="h-5 w-3/4 max-w-prose" />
      {/* The always-shown Name field, outside the ruled list */}
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Bone className="h-4 w-40" />
        <Bone className="h-11 w-full" />
      </div>
      <ul
        aria-hidden="true"
        className="flex flex-col gap-6 border-t border-rule pt-6"
      >
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <EditorFieldSkeleton key={i} textarea={i === 1} />
        ))}
      </ul>
      <div aria-hidden="true">
        <Bone className="h-11 w-24" />
      </div>
      <SectionSkeleton rows={1} />
      <SectionSkeleton rows={1} />
    </div>
  );
}
