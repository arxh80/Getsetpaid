import { FormPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton, streamed the instant the sidebar (or any link)
// navigates here, while events/new/page.tsx resolves on the server. Mirrors that
// page's frame so the content lands where the bones are -- see
// components/skeleton/page-skeletons.tsx for the vocabulary and the
// accessibility contract (one role="status" per surface, bones hidden).
export default function Loading() {
  return <FormPageSkeleton fields={9} textareaAt={8} />;
}
