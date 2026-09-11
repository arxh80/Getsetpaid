import type { Metadata, Viewport } from "next";
import { Source_Serif_4 } from "next/font/google";
import "./globals.css";

const sourceSerif4 = Source_Serif_4({
  variable: "--font-source-serif-4",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "GetSetPaid",
  description: "A UK-first, multi-tenant CRM for the live events industry.",
};

// Paints the mobile browser chrome to match --color-shell, so the address
// bar does not sit as a light band above a near-black page. Next 14+ moved
// themeColor out of `metadata` and into its own `viewport` export.
//
// The literal hex is a sanctioned exception, not a token violation (same
// reasoning as app/icon.svg's ICON_GROUND): this becomes a <meta
// name="theme-color"> tag in the document <head>, which the browser reads
// before any stylesheet loads and cannot resolve a CSS custom property from.
// Must be kept in sync with --color-shell (#0B0B0E) in app/globals.css by
// hand if that token ever changes.
export const viewport: Viewport = {
  themeColor: "#0B0B0E",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sourceSerif4.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
