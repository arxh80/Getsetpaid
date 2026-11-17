import { ListPageSkeleton } from "@/components/skeleton/page-skeletons";
export default function Loading() {
  return <ListPageSkeleton columns={6} filters={1} smallLink={false} />;
}
