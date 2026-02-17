import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vedaa.io — Autonomous Agentic Development Platform",
  description: "Build, deploy, and scale full-stack applications with AI agents. Prompt to code, live preview, one-click publish.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="icon" href="/vedaa-logo.svg" type="image/svg+xml" />
      </head>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
