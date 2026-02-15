import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vedaa — The Agentic Development OS",
  description: "Build, deploy, and scale full-stack applications with AI agents. Vedaa's multi-agent pipeline plans, codes, reviews, and deploys your app in minutes.",
  icons: { icon: "/vedaa-logo.svg" },
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
