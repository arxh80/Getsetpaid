import { FormPageSkeleton } from "@/components/skeleton/page-skeletons";

// Route-level skeleton for Settings › Invoicing: header, eight fields (one tall
// address field), the submit row.
export default function Loading() {
  return <FormPageSkeleton fields={8} textareaAt={1} />;
}
