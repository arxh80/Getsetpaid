import { FormPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton, streamed the instant the sidebar (or any link)
// navigates here, while artists/[artistId]/edit/page.tsx resolves on the server. Mirrors that
// page's frame so the content lands where the bones are -- see
// components/skeleton/page-skeletons.tsx for the vocabulary and the
// accessibility contract (one role="status" per surface, bones hidden).
export default function Loading() {
  return <FormPageSkeleton fields={6} textareaAt={5} social intro={false} />;
}
