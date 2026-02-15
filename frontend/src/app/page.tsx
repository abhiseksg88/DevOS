"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Image from "next/image";

export default function LandingPage() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const timeout = setTimeout(() => setIsLoggedIn(false), 5000);
    supabase.auth
      .getSession()
      .then(({ data }) => {
        clearTimeout(timeout);
        setIsLoggedIn(!!data.session);
      })
      .catch(() => {
        clearTimeout(timeout);
        setIsLoggedIn(false);
      });
    return () => clearTimeout(timeout);
  }, []);

  const ctaText = isLoggedIn ? "Go to Dashboard" : "Get Started";
  const ctaHref = isLoggedIn ? "/dashboard" : "/login";

  return (
    <div className="min-h-screen bg-surface-0 text-white overflow-x-hidden">
      {/* --- Navbar --- */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-surface-0/80 border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto flex items-center justify-between h-16 px-6">
          <div className="flex items-center gap-3">
            <Image src="/vedaa-logo.svg" alt="Vedaa" width={36} height={36} />
            <span className="text-xl font-bold gradient-text">Vedaa</span>
          </div>
          <div className="flex items-center gap-4">
            <a href="#features" className="hidden sm:block text-sm text-slate-400 hover:text-white transition-colors">
              Features
            </a>
            <a href="#how-it-works" className="hidden sm:block text-sm text-slate-400 hover:text-white transition-colors">
              How It Works
            </a>
            <button
              onClick={() => router.push(ctaHref)}
              className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-all glow-brand"
            >
              {isLoggedIn === null ? "..." : isLoggedIn ? "Dashboard" : "Login"}
            </button>
          </div>
        </div>
      </nav>

      {/* --- Hero --- */}
      <section className="relative pt-32 pb-24 sm:pt-44 sm:pb-32 px-6">
        {/* Background effects */}
        <div className="absolute top-20 left-1/4 w-[500px] h-[500px] bg-brand-500/8 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-violet-500/6 rounded-full blur-[100px] pointer-events-none" />

        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-400 text-sm font-medium mb-8">
            <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse-dot" />
            The Agentic Development OS
          </div>

          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold leading-[1.1] tracking-tight mb-6">
            Build apps with
            <br />
            <span className="gradient-text">AI agents.</span>
          </h1>

          <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Describe what you want. Vedaa&apos;s multi-agent pipeline plans, codes, reviews,
            and deploys your application — in minutes, not months.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => router.push(ctaHref)}
              className="w-full sm:w-auto px-8 py-4 rounded-2xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-lg transition-all glow-brand-strong flex items-center justify-center gap-2"
            >
              {ctaText}
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </button>
            <a
              href="#how-it-works"
              className="w-full sm:w-auto px-8 py-4 rounded-2xl glass glass-hover text-slate-300 font-medium text-lg text-center transition-all"
            >
              See How It Works
            </a>
          </div>
        </div>
      </section>

      {/* --- Trusted by / Social proof --- */}
      <section className="py-12 border-y border-white/[0.04]">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <p className="text-sm text-slate-600 uppercase tracking-widest mb-6">Powered by</p>
          <div className="flex flex-wrap items-center justify-center gap-8 text-slate-500">
            <span className="text-lg font-semibold">Claude Opus</span>
            <span className="w-px h-5 bg-surface-3" />
            <span className="text-lg font-semibold">Claude Sonnet</span>
            <span className="w-px h-5 bg-surface-3" />
            <span className="text-lg font-semibold">LangGraph</span>
            <span className="w-px h-5 bg-surface-3" />
            <span className="text-lg font-semibold">Supabase</span>
          </div>
        </div>
      </section>

      {/* --- How It Works --- */}
      <section id="how-it-works" className="py-24 sm:py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              From idea to deployed app in <span className="gradient-text">5 steps</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              Our agentic pipeline handles the entire software development lifecycle autonomously.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            {[
              { step: "01", title: "Describe", desc: "Tell Vedaa what you want to build in plain English", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
              { step: "02", title: "Plan", desc: "Opus architect designs your system and file structure", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
              { step: "03", title: "Code", desc: "Sonnet writes production-quality TypeScript & React", icon: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" },
              { step: "04", title: "Review", desc: "Haiku validates security, correctness, and best practices", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
              { step: "05", title: "Deploy", desc: "One-click publish to Netlify with a live URL", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
            ].map(({ step, title, desc, icon }) => (
              <div
                key={step}
                className="group relative p-6 rounded-2xl glass gradient-border transition-all duration-300 hover:bg-surface-2/60"
              >
                <div className="text-xs text-brand-500 font-mono font-bold mb-3">{step}</div>
                <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mb-4">
                  <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                  </svg>
                </div>
                <h3 className="text-white font-semibold mb-1">{title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- Features --- */}
      <section id="features" className="py-24 sm:py-32 px-6 bg-surface-1/30">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Everything you need to <span className="gradient-text">ship fast</span>
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              A complete development environment powered by AI agents.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                title: "Multi-Agent AI Pipeline",
                desc: "Specialized AI agents for planning, coding, reviewing, and deploying. Each agent excels at its role.",
                icon: "M13 10V3L4 14h7v7l9-11h-7z",
              },
              {
                title: "Live Preview",
                desc: "See your app rendered in real-time as code is generated. In-browser Babel transpilation with zero setup.",
                icon: "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z",
              },
              {
                title: "One-Click Deploy",
                desc: "Publish your app to Netlify with a single click. Get a live URL to share with the world instantly.",
                icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
              },
              {
                title: "Monaco Code Editor",
                desc: "Full VS Code-quality editor with syntax highlighting, IntelliSense, and multi-file support.",
                icon: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
              },
              {
                title: "Multi-Tenant Teams",
                desc: "Create organizations, invite members, manage projects. Enterprise-ready from day one.",
                icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
              },
              {
                title: "Usage & Cost Tracking",
                desc: "Built-in budget enforcement, rate limiting, and usage analytics per tenant and project.",
                icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
              },
            ].map(({ title, desc, icon }) => (
              <div
                key={title}
                className="p-6 rounded-2xl glass gradient-border transition-all duration-300 hover:bg-surface-2/60"
              >
                <div className="w-12 h-12 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                  </svg>
                </div>
                <h3 className="text-white font-semibold text-lg mb-2">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* --- CTA --- */}
      <section className="py-24 sm:py-32 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="relative">
            <div className="absolute inset-0 bg-brand-500/5 rounded-3xl blur-3xl pointer-events-none" />
            <div className="relative p-12 sm:p-16 rounded-3xl glass gradient-border">
              <h2 className="text-3xl sm:text-4xl font-bold mb-4">
                Ready to build with <span className="gradient-text">AI agents</span>?
              </h2>
              <p className="text-slate-400 text-lg mb-8 max-w-lg mx-auto">
                Join Vedaa and start shipping production apps faster than ever.
              </p>
              <button
                onClick={() => router.push(ctaHref)}
                className="px-8 py-4 rounded-2xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-lg transition-all glow-brand-strong"
              >
                {ctaText}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* --- Footer --- */}
      <footer className="border-t border-white/[0.04] py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Image src="/vedaa-logo.svg" alt="Vedaa" width={28} height={28} />
            <span className="text-sm font-semibold gradient-text">Vedaa</span>
          </div>
          <p className="text-slate-600 text-sm">
            &copy; {new Date().getFullYear()} Vedaa. The Agentic Development OS.
          </p>
        </div>
      </footer>
    </div>
  );
}
