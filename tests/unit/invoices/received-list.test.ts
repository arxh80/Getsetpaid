import { describe, expect, it } from "vitest";
import { RECEIVED_LIST, RECEIVED_SELECT, mapReceivedRow } from "@/lib/invoices/received";

describe("RECEIVED_LIST", () => {
  it("sorts newest delivery first on the receiver's list index, and filters by the three statuses a delivery can have", () => {
    expect(RECEIVED_LIST.sort.delivered.column).toBe("delivered_at");
    expect(RECEIVED_LIST.sort.delivered.backedBy).toBe("invoice_deliveries_to_org_list_idx");
    expect(RECEIVED_LIST.sort.delivered.defaultDirection).toBe("desc");
    expect(RECEIVED_LIST.filters.status.choices.map((c) => c.value)).toEqual(["any", "issued", "paid", "void"]);
  });
  it("selects only view columns the list shows, never the snapshot", () => {
    expect(RECEIVED_SELECT).toBe("id, sender_name, number, status, issue_date, due_date, gross_minor, delivered_at");
  });
  it("maps a row", () => {
    expect(
      mapReceivedRow({ id: "d", sender_name: "Alpha", number: "INV-0001", status: "issued", issue_date: "2026-11-01", due_date: "2026-12-01", gross_minor: 12000, delivered_at: "2026-11-17T10:00:00Z" }),
    ).toEqual({ id: "d", senderName: "Alpha", number: "INV-0001", status: "issued", issueDate: "2026-11-01", dueDate: "2026-12-01", grossMinor: 12000, deliveredAt: "2026-11-17T10:00:00Z" });
  });
});
