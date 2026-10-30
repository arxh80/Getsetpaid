import { FormPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton for a new invoice: recipient, event, address, supply
// date, lines and notes.
export default function Loading() {
  return <FormPageSkeleton fields={6} textareaAt={[2, 5]} intro={false} />;
}
