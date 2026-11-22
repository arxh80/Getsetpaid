import "server-only";
// The sender's invoice page reads the network through ONE RPC
// (public.invoice_delivery_state, Invoices part 3): live deliveries and the
// profiles it may deliver to now. A failure shows nothing, never a guess.
import { createClient } from "@/lib/supabase/server";

export interface DeliveryStateRow {
  networkProfileId: string | null;
  displayName: string | null;
  deliveryId: string | null;
  deliveredAt: string | null;
  canDeliver: boolean;
}

export async function loadDeliveryState(invoiceId: string): Promise<DeliveryStateRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_delivery_state", { p_invoice_id: invoiceId });
  if (error) {
    console.error("[invoices] delivery state lookup failed:", error.message);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    networkProfileId: (r.network_profile_id as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    deliveryId: (r.delivery_id as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
    canDeliver: r.can_deliver === true,
  }));
}
