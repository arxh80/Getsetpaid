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
