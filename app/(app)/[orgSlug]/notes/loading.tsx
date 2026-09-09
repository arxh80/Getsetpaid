import { ListPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton, streamed the instant the sidebar (or any link)
// navigates here, while notes/page.tsx resolves on the server. Mirrors that
// page's frame so the content lands where the bones are -- see
// components/skeleton/page-skeletons.tsx for the vocabulary and the
// accessibility contract (one role="status" per surface, bones hidden).
export default function Loading() {
  return <ListPageSkeleton columns={3} filters={2} />;
}
