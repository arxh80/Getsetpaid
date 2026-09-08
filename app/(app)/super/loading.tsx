import { LoadingStatus } from "@/components/skeleton/page-skeletons";

// Skeleton for app/(app)/super/page.tsx, which does nothing but gate and
// redirect -- so the only thing worth streaming is the screen-reader
// announcement, the same "no natural text slot" case
// components/skeleton/page-skeletons.tsx's own header names for a detail or
// form frame with no list on it.
export default function Loading() {
  return <LoadingStatus />;
}
