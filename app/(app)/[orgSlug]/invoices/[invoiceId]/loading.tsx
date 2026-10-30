import { DetailPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton for one invoice: its details, the lines and the actions.
export default function Loading() {
  return <DetailPageSkeleton dlItems={4} sections={2} chips timeline={false} />;
}
