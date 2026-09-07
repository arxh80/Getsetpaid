import { DetailPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton, streamed the instant the sidebar (or any link)
// navigates here, while artists/[artistId]/page.tsx resolves on the server. Mirrors that
// page's frame so the content lands where the bones are -- see
// components/skeleton/page-skeletons.tsx for the vocabulary and the
// accessibility contract (one role="status" per surface, bones hidden).
export default function Loading() {
  return <DetailPageSkeleton dlItems={5} chips sections={4} />;
}
