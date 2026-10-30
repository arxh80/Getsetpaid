import "server-only";
import path from "node:path";
import { Font, renderToBuffer } from "@react-pdf/renderer";
import type { InvoiceSnapshot } from "@/lib/invoices/snapshot";
import { InvoiceDocument } from "@/lib/invoices/pdf/invoice-document";

// Source Serif 4, embedded (Task 1's static TTFs, OFL). Registered once per
// server process.
const FONTS = path.join(process.cwd(), "lib", "invoices", "pdf", "fonts");
let registered = false;
function registerFonts(): void {
  if (registered) return;
  Font.register({
    family: "Source Serif 4",
    fonts: [
      { src: path.join(FONTS, "SourceSerif4-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONTS, "SourceSerif4-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // Never hyphenate a sort code, an account number or an invoice number.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

export async function renderInvoicePdf(
  snapshot: InvoiceSnapshot,
  options: { status: "issued" | "paid" | "void" },
): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<InvoiceDocument snapshot={snapshot} status={options.status} />);
}
