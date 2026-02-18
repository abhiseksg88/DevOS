"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Github, Mail, ArrowRight, Loader2, CheckCircle, Zap } from "lucide-react";
import Image from "next/image";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmationSent, setConfirmationSent] = useState(false);

  // Detect misconfigured Supabase credentials
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isMisconfigured =
    !supabaseUrl ||
    supabaseUrl === "http://localhost:54321" ||
    supabaseUrl.includes("localhost") ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY === "local-dev-anon-key";

  async function handleEmailAuth(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setConfirmationSent(false);

    try {
      const supabase = createClient();

      if (isSignUp) {
        const { data, error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });

        if (authError) {
          setError(authError.message);
          setLoading(false);
          return;
        }

        // If session is null but user exists, email confirmation is required
        if (data.user && !data.session) {
          setConfirmationSent(true);
          setLoading(false);
          return;
        }

        // Auto-confirmed — go to dashboard
        router.push("/dashboard");
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (authError) {
          // Provide friendlier error messages
          if (authError.message === "Invalid login credentials") {
            setError("Invalid email or password. If you just signed up, check your email to confirm your account first.");
          } else if (authError.message === "Email not confirmed") {
            setError("Please confirm your email address. Check your inbox for the confirmation link.");
          } else {
            setError(authError.message);
          }
          setLoading(false);
          return;
        }
        router.push("/dashboard");
      }
    } catch (err) {
      // Network errors (wrong Supabase URL, no connectivity, etc.)
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed")) {
        setError("Cannot connect to authentication server. Please check that NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are configured correctly.");
      } else {
        setError(`Authentication error: ${msg}`);
      }
    }
    setLoading(false);
  }

  async function handleOAuth(provider: "github" | "google") {
    setError("");
    try {
      const supabase = createClient();
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (oauthError) {
        setError(
          `${provider === "github" ? "GitHub" : "Google"} login is not configured yet. Please use email/password or ask the admin to enable ${provider} OAuth in Supabase.`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("Failed")) {
        setError("Cannot connect to authentication server. Check your Supabase environment variables.");
      } else {
        setError(`OAuth error: ${msg}`);
      }
    }
  }

  return (
    <div className="min-h-screen flex bg-surface-0">
      {/* Left — branding */}
      <div className="hidden lg:flex lg:w-1/2 relative items-center justify-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-950 via-surface-0 to-surface-0" />
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-violet-500/10 rounded-full blur-3xl" />

        <div className="relative z-10 max-w-md px-8">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-12 h-12 rounded-xl bg-brand-500 flex items-center justify-center glow-brand">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <span className="text-2xl font-bold gradient-text">Vedaa.io</span>
          </div>
          <h1 className="text-4xl font-bold text-foreground mb-4 leading-tight">
            The Agentic
            <br />
            <span className="gradient-text">Development OS.</span>
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            Describe what you want. Vedaa&apos;s multi-agent pipeline plans, codes, reviews,
            and deploys your application — in minutes, not months.
          </p>

          <div className="mt-12 space-y-4">
            {[
              ["Planner", "Opus architect designs your system"],
              ["Coder", "Sonnet writes production-quality code"],
              ["Reviewer", "Haiku validates security & correctness"],
            ].map(([title, desc]) => (
              <div key={title} className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-brand-500" />
                <div>
                  <span className="text-foreground font-medium">{title}</span>
                  <span className="text-slate-500 ml-2">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-3 mb-10">
            <div className="w-10 h-10 rounded-xl bg-brand-500 flex items-center justify-center">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold gradient-text">Vedaa.io</span>
          </div>

          <h2 className="text-2xl font-bold text-foreground mb-2">
            {isSignUp ? "Create your account" : "Welcome back"}
          </h2>
          <p className="text-slate-500 mb-8">
            {isSignUp ? "Start building with AI agents" : "Sign in to your workspace"}
          </p>

          {/* Email confirmation message */}
          {confirmationSent && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle className="w-5 h-5 text-emerald-400" />
                <span className="text-emerald-400 font-medium">Check your email</span>
              </div>
              <p className="text-sm text-slate-400">
                We sent a confirmation link to <span className="text-foreground font-medium">{email}</span>.
                Click the link to activate your account, then come back and sign in.
              </p>
            </div>
          )}

          {/* Misconfigured env warning */}
          {isMisconfigured && (
            <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <p className="text-sm text-amber-400 font-medium mb-1">Supabase not configured</p>
              <p className="text-xs text-slate-400">
                Set <code className="text-amber-300">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code className="text-amber-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your
                environment variables (Netlify: Site settings → Environment variables).
              </p>
            </div>
          )}

          {/* OAuth */}
          <div className="space-y-3 mb-6">
            <button
              onClick={() => handleOAuth("github")}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl glass glass-hover text-foreground font-medium transition-all"
            >
              <Github className="w-5 h-5" />
              Continue with GitHub
            </button>
            <button
              onClick={() => handleOAuth("google")}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl glass glass-hover text-foreground font-medium transition-all"
            >
              <Mail className="w-5 h-5" />
              Continue with Google
            </button>
          </div>

          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 h-px bg-surface-3" />
            <span className="text-xs text-slate-600 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-surface-3" />
          </div>

          {/* Email form */}
          <form onSubmit={handleEmailAuth} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4 text-foreground placeholder:text-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/50 transition-all"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={6}
                className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4 text-foreground placeholder:text-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/50 transition-all"
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium transition-all disabled:opacity-50 glow-brand"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  {isSignUp ? "Create account" : "Sign in"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
            <button
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError("");
              }}
              className="text-brand-400 hover:text-brand-300 font-medium transition-colors"
            >
              {isSignUp ? "Sign in" : "Sign up"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
