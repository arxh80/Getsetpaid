// The frozen copy private.build_invoice_snapshot() takes at issue
// (20261107000000). The PDF and the issued view render ONLY from this, and
// it is read back from jsonb, so it is parsed -- never cast. A malformed
// snapshot is null, and the caller renders an error rather than half an
// invoice. Number shape matches invoices.number's CHECK, which is what lets
// the PDF filename carry it (spec § PDF).
import { isVatRate, type VatRate } from "@/lib/invoices/arithmetic";

const NUMBER = /^[A-Z0-9-]{0,12}[0-9]{4,10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SnapshotLine {
  position: number;
  description: string;
  quantity: string;
  unitPriceMinor: number;
  vatRate: VatRate;
  netMinor: number;
  vatMinor: number;
}

export interface InvoiceSnapshot {
  number: string;
  issueDate: string;
  supplyDate: string;
  dueDate: string;
  currency: "GBP";
  vatRegistered: boolean;
  seller: {
    name: string;
    address: string;
    vatNumber: string | null;
    bank: { accountName: string; sortCode: string; accountNumber: string } | null;
  };
  recipient: { kind: "company" | "contact"; name: string; address: string; email: string | null };
  lines: SnapshotLine[];
  totals: { netMinor: number; vatMinor: number; grossMinor: number };
  notes: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function line(v: unknown): SnapshotLine | null {
  if (!isObj(v)) return null;
  const position = int(v.position);
  const description = str(v.description);
  const quantity = str(v.quantity);
  const unitPriceMinor = int(v.unit_price_minor);
  const netMinor = int(v.net_minor);
  const vatMinor = int(v.vat_minor);
  if (position === null || !description || !quantity || unitPriceMinor === null) return null;
  if (netMinor === null || vatMinor === null || !isVatRate(v.vat_rate)) return null;
  return { position, description, quantity, unitPriceMinor, vatRate: v.vat_rate, netMinor, vatMinor };
}

export function parseSnapshot(value: unknown): InvoiceSnapshot | null {
  if (!isObj(value) || value.version !== 1 || value.currency !== "GBP") return null;
  const number = str(value.number);
  const issueDate = str(value.issue_date);
  const supplyDate = str(value.supply_date);
  const dueDate = str(value.due_date);
  if (!number || !NUMBER.test(number)) return null;
  if (!issueDate || !supplyDate || !dueDate || ![issueDate, supplyDate, dueDate].every((d) => DATE.test(d))) {
    return null;
  }
  const seller = value.seller;
  const recipient = value.recipient;
  const totals = value.totals;
  if (!isObj(seller) || !isObj(recipient) || !isObj(totals) || !Array.isArray(value.lines)) return null;

  const sellerName = str(seller.name);
  const sellerAddress = str(seller.address);
  const vatNumber = seller.vat_number === null ? null : str(seller.vat_number);
  if (!sellerName || !sellerAddress || (seller.vat_number !== null && !vatNumber)) return null;
  let bank: InvoiceSnapshot["seller"]["bank"] = null;
  if (seller.bank !== null) {
    if (!isObj(seller.bank)) return null;
    const accountName = str(seller.bank.account_name);
    const sortCode = str(seller.bank.sort_code);
    const accountNumber = str(seller.bank.account_number);
    if (!accountName || !sortCode || !accountNumber) return null;
    bank = { accountName, sortCode, accountNumber };
  }

  const kind = recipient.kind;
  const recipientName = str(recipient.name);
  const recipientAddress = str(recipient.address);
  const email = recipient.email === null ? null : str(recipient.email);
  if ((kind !== "company" && kind !== "contact") || !recipientName || !recipientAddress) return null;

  const lines: SnapshotLine[] = [];
  for (const raw of value.lines) {
    const parsed = line(raw);
    if (!parsed) return null;
    lines.push(parsed);
  }

  const netMinor = int(totals.net_minor);
  const vatMinor = int(totals.vat_minor);
  const grossMinor = int(totals.gross_minor);
  if (netMinor === null || vatMinor === null || grossMinor === null || grossMinor !== netMinor + vatMinor) {
    return null;
  }
  const notes = value.notes === null ? null : str(value.notes);

  return {
    number,
    issueDate,
    supplyDate,
    dueDate,
    currency: "GBP",
    vatRegistered: vatNumber !== null,
    seller: { name: sellerName, address: sellerAddress, vatNumber, bank },
    recipient: { kind, name: recipientName, address: recipientAddress, email },
    lines,
    totals: { netMinor, vatMinor, grossMinor },
    notes,
  };
}
