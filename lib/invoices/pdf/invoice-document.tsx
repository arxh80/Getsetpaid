// THE INVOICE PDF, laid out from @react-pdf primitives -- not HTML, so no
// user text can become markup or script (spec § Security 3). Rendered ONLY
// from the snapshot. Fields per HMRC's full VAT invoice requirements: unique
// sequential number; issue date; supply date when it differs; seller name,
// address and VAT number; recipient name and address; per line the
// description, quantity, unit price ex VAT, VAT rate and net amount; total
// net, total VAT, total gross; due date and bank details. With no VAT number
// every VAT field is omitted. A void invoice carries a VOID banner so a
// printed copy cannot be mistaken for a live one.
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { InvoiceSnapshot } from "@/lib/invoices/snapshot";
import { VAT_RATE_LABELS } from "@/lib/invoices/arithmetic";
import { formatGbp } from "@/lib/format/money";
import { formatDateOnly } from "@/lib/format/date";

const s = StyleSheet.create({
  page: { fontFamily: "Source Serif 4", fontSize: 10, padding: 40, color: "#111111" },
  h1: { fontSize: 20, fontWeight: 700, marginBottom: 4 },
  void: { fontSize: 16, fontWeight: 700, borderWidth: 2, padding: 6, marginBottom: 12, textAlign: "center" },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  block: { width: "48%" },
  label: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", marginBottom: 2 },
  th: { flexDirection: "row", borderBottomWidth: 1, paddingBottom: 4, fontWeight: 700 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, paddingVertical: 4 },
  desc: { flex: 1, paddingRight: 8 },
  num: { width: 70, textAlign: "right" },
  rate: { width: 80, paddingLeft: 8 },
  totals: { marginTop: 12, marginLeft: "auto", width: 200 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  strong: { fontWeight: 700 },
  section: { marginTop: 20 },
});

export function InvoiceDocument({ snapshot: x, status }: { snapshot: InvoiceSnapshot; status: "issued" | "paid" | "void" }) {
  return (
    <Document title={`Invoice ${x.number}`} author={x.seller.name}>
      <Page size="A4" style={s.page}>
        {status === "void" ? <Text style={s.void}>VOID — this invoice has been cancelled and is not payable</Text> : null}
        <Text style={s.h1}>Invoice {x.number}</Text>
        <View style={s.row}>
          <View style={s.block}>
            <Text style={s.label}>From</Text>
            <Text style={s.strong}>{x.seller.name}</Text>
            <Text>{x.seller.address}</Text>
            {x.seller.vatNumber ? <Text>VAT number {x.seller.vatNumber}</Text> : null}
          </View>
          <View style={s.block}>
            <Text style={s.label}>To</Text>
            <Text style={s.strong}>{x.recipient.name}</Text>
            <Text>{x.recipient.address}</Text>
          </View>
        </View>
        <View style={s.row}>
          <View style={s.block}>
            <Text>Issue date: {formatDateOnly(x.issueDate)}</Text>
            {x.supplyDate !== x.issueDate ? <Text>Supply date (tax point): {formatDateOnly(x.supplyDate)}</Text> : null}
          </View>
          <View style={s.block}>
            <Text style={s.strong}>Due date: {formatDateOnly(x.dueDate)}</Text>
          </View>
        </View>

        <View style={s.th}>
          <Text style={s.desc}>Description</Text>
          <Text style={s.num}>Quantity</Text>
          <Text style={s.num}>Unit price</Text>
          {x.vatRegistered ? <Text style={s.rate}>VAT rate</Text> : null}
          <Text style={s.num}>Net</Text>
        </View>
        {x.lines.map((l) => (
          <View key={l.position} style={s.tr} wrap={false}>
            <Text style={s.desc}>{l.description}</Text>
            <Text style={s.num}>{l.quantity}</Text>
            <Text style={s.num}>{formatGbp(l.unitPriceMinor)}</Text>
            {x.vatRegistered ? <Text style={s.rate}>{VAT_RATE_LABELS[l.vatRate]}</Text> : null}
            <Text style={s.num}>{formatGbp(l.netMinor)}</Text>
          </View>
        ))}

        <View style={s.totals}>
          <View style={s.totalRow}><Text>Total net</Text><Text>{formatGbp(x.totals.netMinor)}</Text></View>
          {x.vatRegistered ? (
            <View style={s.totalRow}><Text>Total VAT</Text><Text>{formatGbp(x.totals.vatMinor)}</Text></View>
          ) : null}
          <View style={s.totalRow}><Text style={s.strong}>Total due</Text><Text style={s.strong}>{formatGbp(x.totals.grossMinor)}</Text></View>
        </View>

        <View style={s.section}>
          <Text style={s.label}>How to pay</Text>
          {x.seller.bank ? (
            <Text>
              Bank transfer to {x.seller.bank.accountName}, sort code {x.seller.bank.sortCode}, account number{" "}
              {x.seller.bank.accountNumber}. Please quote {x.number}.
            </Text>
          ) : (
            <Text>Contact {x.seller.name} for payment details, quoting {x.number}.</Text>
          )}
        </View>
        {x.notes ? (
          <View style={s.section}>
            <Text style={s.label}>Notes</Text>
            <Text>{x.notes}</Text>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}
