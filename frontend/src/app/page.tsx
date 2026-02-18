"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowRight,
  Sparkles,
  Eye,
  Database,
  Shield,
  Layers,
  ChevronRight,
  Sun,
  Moon,
  Zap,
  Code2,
  Rocket,
  Globe,
  GitBranch,
  Bot,
  Cpu,
  Play,
} from "lucide-react";
import Image from "next/image";
import { useTheme } from "@/components/ThemeProvider";

export default function LandingPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    try {
      const supabase = createClient();
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          router.replace("/dashboard");
        } else {
          setChecking(false);
        }
      }).catch(() => {
        setChecking(false);
      });
    } catch {
      setChecking(false);
    }
  }, [router]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-0">
        <div className="animate-pulse-dot">
          <div className="w-8 h-8 rounded-full bg-brand-500/30 flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-brand-500" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-0 text-foreground overflow-hidden">
      {/* ================================================================
          NAVIGATION — frosted glass, minimal
          ================================================================ */}
      <nav className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-white/[0.04] backdrop-blur-2xl bg-surface-0/70">
        <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image
              src="/vedaa-logo.svg"
              alt="Vedaa"
              width={32}
              height={32}
              className="rounded-lg"
            />
            <div className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-foreground leading-tight">Vedaa</span>
              <span className="text-[9px] text-slate-500 uppercase tracking-[0.2em] leading-tight">Agentic Coding Platform</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-slate-400 hover:text-foreground transition-colors duration-300">Features</a>
            <a href="#how-it-works" className="text-sm text-slate-400 hover:text-foreground transition-colors duration-300">How It Works</a>
            <a href="#pricing" className="text-sm text-slate-400 hover:text-foreground transition-colors duration-300">Pricing</a>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-xl text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all duration-300"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 text-sm text-slate-300 hover:text-foreground transition-colors duration-300"
            >
              Sign In
            </button>
            <button
              onClick={() => router.push("/login")}
              className="group px-5 py-2.5 rounded-xl bg-brand-500 text-white text-sm font-semibold hover:bg-brand-400 transition-all duration-300 shadow-lg shadow-brand-500/20 hover:shadow-brand-500/40 hover:scale-[1.02]"
            >
              Get Started Free
            </button>
          </div>
        </div>
      </nav>

      {/* ================================================================
          HERO — centered prompt-style, organic gradients, bold type
          ================================================================ */}
      <section className="relative pt-32 pb-40 px-6">
        {/* Ambient gradient blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[1000px] h-[700px] bg-brand-500/[0.07] rounded-full blur-[150px] animate-pulse-slow" />
          <div className="absolute top-60 -right-40 w-[500px] h-[500px] bg-violet-600/[0.05] rounded-full blur-[120px]" />
          <div className="absolute top-40 -left-40 w-[400px] h-[400px] bg-indigo-500/[0.04] rounded-full blur-[100px]" />
          {/* Subtle noise grain overlay */}
          <div className="absolute inset-0 opacity-[0.015] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48ZmlsdGVyIGlkPSJhIiB4PSIwIiB5PSIwIj48ZmVUdXJidWxlbmNlIHR5cGU9ImZyYWN0YWxOb2lzZSIgYmFzZUZyZXF1ZW5jeT0iLjc1IiBzdGl0Y2hUaWxlcz0ic3RpdGNoIi8+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9IjMwMCIgaGVpZ2h0PSIzMDAiIGZpbHRlcj0idXJsKCNhKSIgb3BhY2l0eT0iMC40Ii8+PC9zdmc+')]" />
        </div>

        <div className="relative max-w-5xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-brand-500/[0.08] border border-brand-500/[0.15] text-brand-400 text-xs font-medium mb-8 backdrop-blur-sm">
            <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
            AI-Powered Full-Stack Development
          </div>

          {/* Main heading */}
          <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-[-0.04em] leading-[0.95] mb-7">
            <span className="block">Describe it.</span>
            <span className="block gradient-text">Vedaa builds it.</span>
          </h1>

          <p className="text-lg md:text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed">
            AI agents that plan, code, review, and deploy your full-stack applications.
            From idea to production in minutes.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <button
              onClick={() => router.push("/login")}
              className="group flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-brand-500 text-white font-semibold text-base hover:bg-brand-400 transition-all duration-300 shadow-xl shadow-brand-500/25 hover:shadow-brand-500/40 hover:scale-[1.02]"
            >
              Start Building Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-300" />
            </button>
            <a
              href="#how-it-works"
              className="group flex items-center gap-2.5 px-8 py-4 rounded-2xl bg-surface-1/60 border border-surface-3/50 text-foreground font-semibold text-base backdrop-blur-sm hover:bg-surface-1 hover:border-surface-4 transition-all duration-300"
            >
              <Play className="w-4 h-4 text-brand-400" />
              Watch Demo
            </a>
          </div>

          <p className="text-xs text-slate-600 mb-16">No credit card required. 5 free projects.</p>

          {/* Hero visual — Glassmorphic workspace preview */}
          <div className="relative max-w-4xl mx-auto">
            {/* Glow behind the card */}
            <div className="absolute -inset-8 bg-brand-500/[0.06] rounded-3xl blur-3xl" />

            <div className="relative rounded-2xl border border-white/[0.06] bg-surface-1/60 backdrop-blur-2xl shadow-2xl shadow-black/40 overflow-hidden">
              {/* Browser chrome */}
              <div className="h-11 bg-surface-2/40 border-b border-white/[0.04] flex items-center px-4 gap-2">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-red-500/50" />
                  <div className="w-3 h-3 rounded-full bg-amber-500/50" />
                  <div className="w-3 h-3 rounded-full bg-emerald-500/50" />
                </div>
                <div className="flex-1 mx-8">
                  <div className="max-w-md mx-auto py-1.5 px-4 rounded-lg bg-surface-3/30 text-xs text-slate-500 font-mono text-center">
                    vedaa.io/workspace
                  </div>
                </div>
              </div>

              {/* Simulated workspace */}
              <div className="flex h-[340px]">
                {/* Left — Chat panel */}
                <div className="w-[260px] border-r border-white/[0.04] flex flex-col">
                  <div className="px-4 py-3 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-3 h-3 text-brand-400" />
                      <span className="text-2xs font-semibold text-slate-500 uppercase tracking-wider">AI Chat</span>
                    </div>
                  </div>
                  <div className="flex-1 p-4 space-y-3">
                    {/* User message */}
                    <div className="flex justify-end">
                      <div className="px-3 py-2 rounded-xl bg-brand-500/10 border border-brand-500/20 text-xs text-slate-300 max-w-[85%]">
                        Build me a modern SaaS dashboard with analytics
                      </div>
                    </div>
                    {/* Agent response */}
                    <div className="flex justify-start">
                      <div className="px-3 py-2 rounded-xl bg-surface-2/50 border border-white/[0.04] text-xs text-slate-400 max-w-[85%]">
                        <div className="flex items-center gap-1.5 mb-1">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="text-emerald-400 font-medium">Generating 12 files...</span>
                        </div>
                        React + TypeScript + Tailwind CSS
                      </div>
                    </div>
                    {/* Pipeline */}
                    <div className="flex items-center gap-3 px-2 py-2">
                      {[
                        { l: "Plan", c: "bg-emerald-400" },
                        { l: "Code", c: "bg-emerald-400" },
                        { l: "Review", c: "bg-blue-400 animate-pulse" },
                        { l: "Fix", c: "bg-slate-600" },
                      ].map(({ l, c }) => (
                        <div key={l} className="flex items-center gap-1.5">
                          <div className={`w-1.5 h-1.5 rounded-full ${c}`} />
                          <span className="text-2xs text-slate-500">{l}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Right — Preview */}
                <div className="flex-1 flex flex-col">
                  <div className="px-3 py-2 border-b border-white/[0.04] flex items-center gap-1">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-3/30 text-2xs text-foreground font-medium">
                      <Eye className="w-3 h-3" />
                      Preview
                    </div>
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs text-slate-600 font-medium">
                      <Globe className="w-3 h-3" />
                      Cloud
                    </div>
                  </div>
                  <div className="flex-1 bg-gradient-to-br from-surface-2/30 to-surface-1/20 p-6 flex items-center justify-center">
                    <div className="w-full max-w-sm space-y-4">
                      <div className="h-6 w-32 rounded bg-brand-500/20" />
                      <div className="h-3 w-48 rounded bg-surface-3/40" />
                      <div className="grid grid-cols-3 gap-2 pt-2">
                        <div className="h-20 rounded-lg bg-surface-3/20 border border-white/[0.03]" />
                        <div className="h-20 rounded-lg bg-surface-3/20 border border-white/[0.03]" />
                        <div className="h-20 rounded-lg bg-surface-3/20 border border-white/[0.03]" />
                      </div>
                      <div className="h-24 rounded-lg bg-surface-3/20 border border-white/[0.03]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================
          TRUSTED BY / SOCIAL PROOF
          ================================================================ */}
      <section className="py-16 px-6 border-t border-surface-3/30">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs text-slate-600 uppercase tracking-[0.2em] mb-8 font-medium">Powered by cutting-edge AI</p>
          <div className="flex items-center justify-center gap-12 flex-wrap opacity-40">
            {["Claude AI", "React", "TypeScript", "Tailwind CSS", "Supabase", "Next.js"].map((t) => (
              <span key={t} className="text-sm font-semibold text-slate-400 tracking-wide">{t}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================
          FEATURES — Bento grid with glass cards
          ================================================================ */}
      <section id="features" className="py-28 px-6 relative">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] bg-brand-500/[0.03] rounded-full blur-[150px]" />
        </div>

        <div className="relative max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/[0.08] border border-brand-500/[0.12] text-brand-400 text-xs font-medium mb-5">
              <Zap className="w-3 h-3" />
              Features
            </div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">
              Everything to ship fast
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              From prompt to production. No setup, no config, no boilerplate.
            </p>
          </div>

          {/* Bento grid */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: Bot,
                title: "Autonomous Agents",
                description: "Plan, Code, Review, Fix — four specialized AI agents collaborate to build your app end-to-end.",
                accent: "from-violet-500/20 to-purple-500/5",
              },
              {
                icon: Eye,
                title: "Live Preview",
                description: "Watch your app render in real-time. Full React runtime with hooks, state, and component interactivity.",
                accent: "from-blue-500/20 to-cyan-500/5",
              },
              {
                icon: Rocket,
                title: "One-Click Deploy",
                description: "Publish to your own subdomain instantly. Your app goes live at appname.vedaa.io with SSL.",
                accent: "from-emerald-500/20 to-green-500/5",
              },
              {
                icon: Database,
                title: "Built-in Database",
                description: "Supabase-powered data layer. Store, query, and sync data with real-time subscriptions.",
                accent: "from-amber-500/20 to-orange-500/5",
              },
              {
                icon: GitBranch,
                title: "Version History",
                description: "Every generation is saved. Roll back to any previous version with one click.",
                accent: "from-pink-500/20 to-rose-500/5",
              },
              {
                icon: Shield,
                title: "Enterprise Security",
                description: "Row-level security, encrypted credentials, tenant isolation. Production-ready from day one.",
                accent: "from-indigo-500/20 to-blue-500/5",
              },
            ].map(({ icon: Icon, title, description, accent }) => (
              <div
                key={title}
                className="group relative p-6 rounded-2xl bg-surface-1/40 border border-white/[0.04] hover:border-white/[0.08] backdrop-blur-sm transition-all duration-500 hover:bg-surface-1/60"
              >
                {/* Subtle gradient on hover */}
                <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${accent} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                <div className="relative">
                  <div className="w-11 h-11 rounded-xl bg-surface-2/60 border border-white/[0.06] flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                    <Icon className="w-5 h-5 text-brand-400" />
                  </div>
                  <h3 className="text-base font-semibold mb-2 text-foreground">{title}</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================
          HOW IT WORKS — Numbered steps with visual timeline
          ================================================================ */}
      <section id="how-it-works" className="py-28 px-6 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-brand-500/[0.02] to-transparent pointer-events-none" />

        <div className="relative max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/[0.08] border border-brand-500/[0.12] text-brand-400 text-xs font-medium mb-5">
              <Cpu className="w-3 h-3" />
              How It Works
            </div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">
              Three steps to launch
            </h2>
            <p className="text-slate-400 text-lg">
              From idea to live app in under 5 minutes.
            </p>
          </div>

          <div className="space-y-6">
            {[
              {
                step: "01",
                title: "Describe Your App",
                description: "Tell the AI what you want to build in plain English. Be as detailed or as vague as you like.",
                gradient: "from-brand-500/10 to-violet-500/5",
              },
              {
                step: "02",
                title: "Watch Agents Build",
                description: "Four AI agents collaborate: Planner analyzes requirements, Coder generates files, Reviewer checks quality, Fixer resolves issues.",
                gradient: "from-blue-500/10 to-cyan-500/5",
              },
              {
                step: "03",
                title: "Preview & Publish",
                description: "See your app running live in the preview. Click Publish and it's deployed to your own subdomain.",
                gradient: "from-emerald-500/10 to-green-500/5",
              },
            ].map(({ step, title, description, gradient }) => (
              <div
                key={step}
                className={`group flex items-start gap-6 p-7 rounded-2xl bg-gradient-to-r ${gradient} border border-white/[0.04] hover:border-white/[0.08] backdrop-blur-sm transition-all duration-500`}
              >
                <div className="shrink-0 w-14 h-14 rounded-2xl bg-surface-2/60 border border-white/[0.06] flex items-center justify-center text-brand-400 text-lg font-bold font-mono group-hover:scale-110 transition-transform duration-300">
                  {step}
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-2 text-foreground">{title}</h3>
                  <p className="text-slate-400 leading-relaxed">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================
          PRICING — Clean cards with glass effect
          ================================================================ */}
      <section id="pricing" className="py-28 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/[0.08] border border-brand-500/[0.12] text-brand-400 text-xs font-medium mb-5">
              <Sparkles className="w-3 h-3" />
              Pricing
            </div>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-4">
              Simple, transparent pricing
            </h2>
            <p className="text-slate-400 text-lg">
              Start free. Scale when you&apos;re ready.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {[
              {
                name: "Free",
                price: "$0",
                period: "forever",
                features: ["5 projects", "10 generations/day", "Vedaa subdomain", "Community support"],
                cta: "Get Started",
                featured: false,
              },
              {
                name: "Pro",
                price: "$29",
                period: "/month",
                features: ["Unlimited projects", "100 generations/day", "Custom domains", "Priority support", "Version history"],
                cta: "Start Pro Trial",
                featured: true,
              },
              {
                name: "Enterprise",
                price: "Custom",
                period: "",
                features: ["Unlimited everything", "SSO / SAML", "Dedicated infra", "SLA guarantee", "White-label option"],
                cta: "Contact Sales",
                featured: false,
              },
            ].map(({ name, price, period, features, cta, featured }) => (
              <div
                key={name}
                className={`relative p-8 rounded-2xl border transition-all duration-500 hover:scale-[1.02] ${
                  featured
                    ? "bg-brand-500/[0.06] border-brand-500/20 shadow-xl shadow-brand-500/[0.08]"
                    : "bg-surface-1/40 border-white/[0.04] hover:border-white/[0.08]"
                }`}
              >
                {featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full bg-brand-500 text-white text-xs font-semibold shadow-lg shadow-brand-500/30">
                    Most Popular
                  </div>
                )}
                <h3 className="text-xl font-bold mb-1 text-foreground">{name}</h3>
                <div className="flex items-baseline gap-1 mb-8">
                  <span className="text-4xl font-bold tracking-tight text-foreground">{price}</span>
                  <span className="text-slate-500 text-sm">{period}</span>
                </div>
                <ul className="space-y-3 mb-8">
                  {features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm text-slate-300">
                      <div className="w-1 h-1 rounded-full bg-brand-400 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => router.push("/login")}
                  className={`w-full py-3 rounded-xl text-sm font-semibold transition-all duration-300 ${
                    featured
                      ? "bg-brand-500 text-white hover:bg-brand-400 shadow-lg shadow-brand-500/20"
                      : "bg-surface-2/60 border border-white/[0.06] text-foreground hover:bg-surface-2 hover:border-white/[0.1]"
                  }`}
                >
                  {cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================
          FINAL CTA — Bold, gradient-backed
          ================================================================ */}
      <section className="py-32 px-6 relative">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-brand-500/[0.06] rounded-full blur-[150px]" />
        </div>

        <div className="relative max-w-3xl mx-auto text-center">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Ready to build?
          </h2>
          <p className="text-slate-400 text-lg mb-10 max-w-lg mx-auto">
            Join developers shipping full-stack apps 10x faster with autonomous AI agents.
          </p>
          <button
            onClick={() => router.push("/login")}
            className="group inline-flex items-center gap-2.5 px-10 py-4 rounded-2xl bg-brand-500 text-white font-semibold text-lg hover:bg-brand-400 transition-all duration-300 shadow-xl shadow-brand-500/25 hover:shadow-brand-500/40 hover:scale-[1.02]"
          >
            Start Building Free
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform duration-300" />
          </button>
        </div>
      </section>

      {/* ================================================================
          FOOTER
          ================================================================ */}
      <footer className="border-t border-white/[0.04] py-12 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex items-center gap-3">
              <Image
                src="/vedaa-logo.svg"
                alt="Vedaa"
                width={24}
                height={24}
                className="rounded-md"
              />
              <div className="flex flex-col">
                <span className="text-sm font-bold tracking-tight text-foreground leading-tight">Vedaa</span>
                <span className="text-[9px] text-slate-600 uppercase tracking-[0.2em] leading-tight">Agentic Coding Platform</span>
              </div>
            </div>

            <div className="flex items-center gap-8">
              <a href="#features" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Features</a>
              <a href="#how-it-works" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">How It Works</a>
              <a href="#pricing" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Pricing</a>
            </div>

            <p className="text-xs text-slate-600">
              &copy; {new Date().getFullYear()} Vedaa. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
