import type { Metadata, Viewport } from "next";
import "./globals.css";

// Titles are static strings, never built from visitor data, so PII can't leak via the tab title or history.
export const metadata: Metadata = {
  title: "QuoteLane | Compare Auto Insurance Quotes",
  description: "Answer a few quick questions and compare auto insurance quotes in minutes.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d4ed8",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
