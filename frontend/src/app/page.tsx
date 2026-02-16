"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Zap,
  Code2,
  Globe,
  Rocket,
  ArrowRight,
  Sparkles,
  Eye,
  Database,
  Shield,
  Layers,
  ChevronRight,
} from "lucide-react";

export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace("/dashboard");
      } else {
        setChecking(false);
      }
    });
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
    <div className="min-h-screen bg-surface-0 text-white overflow-hidden">
      {/* Nav */}
      <nav className="relative z-50 h-16 border-b border-surface-3/50 backdrop-blur-xl bg-surface-0/80">
        <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand-500 flex items-center justify-center glow-brand">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold gradient-text tracking-tight">Vedaa.io</span>
          </div>
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-slate-400 hover:text-white transition-colors">Features</a>
            <a href="#how-it-works" className="text-sm text-slate-400 hover:text-white transition-colors">How It Works</a>
            <a href="#pricing" className="text-sm text-slate-400 hover:text-white transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors"
            >
              Sign In
            </button>
            <button
              onClick={() => router.push("/login")}
              className="px-5 py-2 rounded-xl bg-brand-500 text-white text-sm font-semibold hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40"
            >
              Get Started
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-24 pb-32 px-6">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-brand-500/8 rounded-full blur-[120px]" />
          <div className="absolute top-40 right-0 w-[400px] h-[400px] bg-violet-500/5 rounded-full blur-[80px]" />
        </div>

        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium mb-8">
            <Sparkles className="w-3.5 h-3.5" />
            Autonomous Agentic Development Platform
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
            Build Full-Stack Apps
            <br />
            <span className="gradient-text">with AI Agents</span>
          </h1>

          <p className="text-lg md:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Describe what you want. Vedaa&apos;s AI agents plan, code, preview, and deploy your
            application — all in minutes. No framework knowledge needed.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => router.push("/login")}
              className="group flex items-center gap-2 px-8 py-3.5 rounded-xl bg-brand-500 text-white font-semibold hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40"
            >
              Start Building Free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <a
              href="#how-it-works"
              className="flex items-center gap-2 px-8 py-3.5 rounded-xl glass glass-hover font-semibold transition-all"
            >
              See How It Works
            </a>
          </div>

          {/* Hero visual */}
          <div className="mt-16 relative">
            <div className="rounded-2xl border border-surface-3/50 bg-surface-1/80 backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden">
              <div className="h-10 bg-surface-2/50 border-b border-surface-3 flex items-center px-4 gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/60" />
                <div className="w-3 h-3 rounded-full bg-amber-500/60" />
                <div className="w-3 h-3 rounded-full bg-emerald-500/60" />
                <div className="flex-1 mx-4 py-1 px-3 rounded-md bg-surface-3/50 text-xs text-slate-500 font-mono">
                  vedaa.io/workspace
                </div>
              </div>
              <div className="p-8 md:p-12 text-left">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-brand-500/20 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-brand-400" />
                  </div>
                  <span className="text-sm text-slate-400">AI Agent</span>
                </div>
                <div className="space-y-2 text-sm font-mono">
                  <p className="text-slate-500">
                    <span className="text-brand-400">{'>'}</span> Build me a modern SaaS dashboard with user analytics,
                    real-time charts, and dark mode
                  </p>
                  <div className="pt-2 flex items-center gap-2 text-emerald-400">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>Generating 8 files... React + TypeScript + Tailwind</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Everything You Need to Ship Fast
            </h2>
            <p className="text-slate-400 text-lg max-w-xl mx-auto">
              From idea to production in minutes, not weeks.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Code2,
                title: "Prompt to Code",
                description: "Describe your app in plain English. Claude generates production-ready React, TypeScript, and Tailwind CSS.",
              },
              {
                icon: Eye,
                title: "Live Preview",
                description: "See your app running in real-time as code is generated. Full React runtime with hooks, state, and interactivity.",
              },
              {
                icon: Rocket,
                title: "One-Click Publish",
                description: "Deploy to your own subdomain instantly. Your app goes live at appname.vedaa.io with SSL.",
              },
              {
                icon: Database,
                title: "Built-in Database",
                description: "Supabase-powered data layer. Your apps can store and query data with real-time sync out of the box.",
              },
              {
                icon: Layers,
                title: "Infrastructure Dashboard",
                description: "Browse tables, manage storage, inspect schemas. Full visibility into your app's data layer.",
              },
              {
                icon: Shield,
                title: "Enterprise Security",
                description: "Row-level security, encrypted credentials, tenant isolation. Built for production from day one.",
              },
            ].map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="group p-6 rounded-2xl bg-surface-1/50 border border-surface-3/50 hover:border-brand-500/30 transition-all hover:bg-surface-1"
              >
                <div className="w-12 h-12 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mb-4 group-hover:bg-brand-500/20 transition-all">
                  <Icon className="w-6 h-6 text-brand-400" />
                </div>
                <h3 className="text-lg font-semibold mb-2">{title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="py-24 px-6 relative">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-brand-500/3 to-transparent pointer-events-none" />
        <div className="relative max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Three Steps to Launch
            </h2>
            <p className="text-slate-400 text-lg">
              From idea to live app in under 5 minutes.
            </p>
          </div>

          <div className="space-y-8">
            {[
              {
                step: "01",
                title: "Describe Your App",
                description: "Tell the AI what you want to build. Be as detailed or as vague as you like — it handles the rest.",
              },
              {
                step: "02",
                title: "Watch It Build",
                description: "AI agents generate your code in real-time. See the live preview update as each component is created.",
              },
              {
                step: "03",
                title: "Publish & Share",
                description: "Click Publish. Your app goes live at a custom subdomain. Share it with the world.",
              },
            ].map(({ step, title, description }) => (
              <div
                key={step}
                className="flex items-start gap-6 p-6 rounded-2xl bg-surface-1/30 border border-surface-3/30"
              >
                <div className="shrink-0 w-14 h-14 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 text-lg font-bold font-mono">
                  {step}
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-1">{title}</h3>
                  <p className="text-slate-400 leading-relaxed">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-slate-400 text-lg">
              Start free. Scale as you grow.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                name: "Free",
                price: "$0",
                period: "forever",
                features: ["5 projects", "10 generations/day", "Netlify subdomain", "Community support"],
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
                features: ["Unlimited everything", "SSO / SAML", "Dedicated infrastructure", "SLA guarantee", "White-label option"],
                cta: "Contact Sales",
                featured: false,
              },
            ].map(({ name, price, period, features, cta, featured }) => (
              <div
                key={name}
                className={`p-8 rounded-2xl border ${
                  featured
                    ? "bg-brand-500/5 border-brand-500/30 shadow-lg shadow-brand-500/10"
                    : "bg-surface-1/50 border-surface-3/50"
                }`}
              >
                {featured && (
                  <div className="inline-flex items-center px-3 py-1 rounded-full bg-brand-500/20 text-brand-400 text-xs font-medium mb-4">
                    Most Popular
                  </div>
                )}
                <h3 className="text-xl font-bold mb-1">{name}</h3>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-4xl font-bold">{price}</span>
                  <span className="text-slate-500 text-sm">{period}</span>
                </div>
                <ul className="space-y-3 mb-8">
                  {features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-slate-300">
                      <ChevronRight className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => router.push("/login")}
                  className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
                    featured
                      ? "bg-brand-500 text-white hover:bg-brand-600 shadow-lg shadow-brand-500/25"
                      : "glass glass-hover text-white"
                  }`}
                >
                  {cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Ready to Build Something Amazing?
          </h2>
          <p className="text-slate-400 text-lg mb-8">
            Join developers shipping apps 10x faster with AI agents.
          </p>
          <button
            onClick={() => router.push("/login")}
            className="group inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-brand-500 text-white font-semibold text-lg hover:bg-brand-600 transition-all shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40"
          >
            Start Building Free
            <ArrowRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-3/50 py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-semibold gradient-text">Vedaa.io</span>
          </div>
          <p className="text-xs text-slate-600">
            &copy; {new Date().getFullYear()} Vedaa.io. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
