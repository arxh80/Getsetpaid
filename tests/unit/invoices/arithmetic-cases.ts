// THE ONE CASE TABLE for line and VAT arithmetic. The TypeScript port is
// tested against it here; the SQL function is tested against a copy in
// supabase/tests/rls_invoices.sql, and arithmetic-cases-match-sql.test.ts
// (Task 3) fails if the two copies differ by one row. Rule: per line,
// net = round_half_up(quantity × unit price), vat = round_half_up(net × rate).
import type { VatRate } from "@/lib/invoices/arithmetic";

export interface ArithmeticCase {
  quantity: string;
  unitPriceMinor: number;
  rate: VatRate;
  netMinor: number;
  vatMinor: number;
}

export const ARITHMETIC_CASES: readonly ArithmeticCase[] = [
  { quantity: "1.00", unitPriceMinor: 10000, rate: "standard_20", netMinor: 10000, vatMinor: 2000 },
  { quantity: "2.50", unitPriceMinor: 333, rate: "standard_20", netMinor: 833, vatMinor: 167 },
  { quantity: "0.01", unitPriceMinor: 1, rate: "standard_20", netMinor: 0, vatMinor: 0 },
  { quantity: "0.50", unitPriceMinor: 1, rate: "standard_20", netMinor: 1, vatMinor: 0 },
  { quantity: "3.00", unitPriceMinor: 1999, rate: "reduced_5", netMinor: 5997, vatMinor: 300 },
  { quantity: "1.00", unitPriceMinor: 250, rate: "standard_20", netMinor: 250, vatMinor: 50 },
  { quantity: "1.00", unitPriceMinor: 2, rate: "reduced_5", netMinor: 2, vatMinor: 0 },
  { quantity: "1.00", unitPriceMinor: 10, rate: "reduced_5", netMinor: 10, vatMinor: 1 },
  { quantity: "7.25", unitPriceMinor: 100, rate: "zero", netMinor: 725, vatMinor: 0 },
  { quantity: "1.00", unitPriceMinor: 12345, rate: "exempt", netMinor: 12345, vatMinor: 0 },
  { quantity: "1.00", unitPriceMinor: 12345, rate: "none", netMinor: 12345, vatMinor: 0 },
  { quantity: "12.34", unitPriceMinor: 5678, rate: "standard_20", netMinor: 70067, vatMinor: 14013 },
];
