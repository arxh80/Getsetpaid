import { HubSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton for the workspace hub ([orgSlug]/page.tsx): the name
// and role line, then the stacked bordered cards (upcoming events, open
// tasks, the navigation sections). Streamed instantly on the sidebar's
// in-place swap; see components/skeleton/page-skeletons.tsx.
export default function Loading() {
  return <HubSkeleton />;
}
