import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blank Demo",
  description: "Who stands behind a sealed photo.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
