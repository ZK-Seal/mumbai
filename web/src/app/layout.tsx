import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import "./globals.css";

/** The app's typeface. */
const sans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "zkSeal",
  description: "Who stands behind a sealed photo.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
