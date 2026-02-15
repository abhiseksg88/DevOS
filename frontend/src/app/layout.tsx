import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NimbusForge — AI Cloud App Builder",
  description: "Build, deploy, and scale full-stack applications with AI agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
