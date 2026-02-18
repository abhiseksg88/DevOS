import type { Metadata } from "next";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vedaa.io — Autonomous Agentic Development Platform",
  description: "Build, deploy, and scale full-stack applications with AI agents. Prompt to code, live preview, one-click publish.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/vedaa-logo.svg" type="image/svg+xml" />
        {/* Inline script to prevent FOUC — applies saved theme before React hydrates */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('vedaa-theme');
                if (t === 'light') document.documentElement.classList.remove('dark');
                else if (!t && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.classList.remove('dark');
              } catch(e) {}
            `,
          }}
        />
      </head>
      <body className="min-h-screen font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
