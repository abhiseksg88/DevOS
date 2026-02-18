"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as db from "@/lib/supabase-db";
import { cn, timeAgo } from "@/lib/utils";
import type { Tenant, Project } from "@/types";
import {
  Plus,
  FolderOpen,
  Clock,
  Zap,
  X,
  Loader2,
  Layers,
  ArrowRight,
  AlertTriangle,
  Send,
  Sparkles,
} from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewTenant, setShowNewTenant] = useState(false);
  const [promptValue, setPromptValue] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const t = await db.listTenants();
        setTenants(t);
        if (t.length > 0) {
          setActiveTenant(t[0]);
          const p = await db.listProjects(t[0].id);
          setProjects(p);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load. Make sure Supabase migrations are applied."
        );
      }
      setLoading(false);
    })();
  }, []);

  async function handleSelectTenant(tenant: Tenant) {
    setActiveTenant(tenant);
    try {
      const p = await db.listProjects(tenant.id);
      setProjects(p);
    } catch {
      setProjects([]);
    }
  }

  async function handlePromptSubmit() {
    if (!promptValue.trim() || !activeTenant || creatingProject) return;
    setCreatingProject(true);
    setPromptError(null);

    try {
      // Create a new project from the prompt
      const name = promptValue.trim().slice(0, 50);
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);

      const p = await db.createProject(
        activeTenant.id,
        name,
        slug || "new-project",
        promptValue.trim(),
        { framework: "nextjs", language: "typescript" }
      );

      // Navigate to project with initial prompt
      router.push(`/project/${p.id}?tenant=${activeTenant.id}&prompt=${encodeURIComponent(promptValue.trim())}`);
    } catch (err) {
      console.error("Failed to create project:", err);
      setPromptError(err instanceof Error ? err.message : "Failed to create project. Please try again.");
      setCreatingProject(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-3.5rem)]">
        <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
      </div>
    );
  }

  // Show setup error
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3.5rem)] px-6">
        <div className="w-20 h-20 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-6">
          <AlertTriangle className="w-10 h-10 text-red-400" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-3">Database Setup Required</h1>
        <p className="text-slate-400 text-center max-w-lg mb-4">{error}</p>
        <div className="text-left bg-surface-2 border border-surface-3 rounded-xl p-4 max-w-lg w-full">
          <p className="text-sm text-slate-300 mb-2 font-medium">Run these SQL files in your Supabase Dashboard &gt; SQL Editor:</p>
          <ol className="text-sm text-slate-400 space-y-1 list-decimal list-inside">
            <li><code className="text-brand-400">supabase/migrations/001_core_schema.sql</code></li>
            <li><code className="text-brand-400">supabase/migrations/002_rpc_functions.sql</code></li>
            <li><code className="text-brand-400">supabase/migrations/003_frontend_rpc.sql</code></li>
          </ol>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium transition-all"
        >
          Retry
        </button>
      </div>
    );
  }

  // If no tenants, show onboarding
  if (tenants.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-3.5rem)] px-6">
        <div className="w-20 h-20 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mb-6 glow-brand">
          <Zap className="w-10 h-10 text-brand-400" />
        </div>
        <h1 className="text-3xl font-bold text-foreground mb-3">Welcome to Vedaa</h1>
        <p className="text-slate-400 text-center max-w-md mb-8">
          Create your first organization to start building AI-powered applications.
        </p>
        <button
          onClick={() => setShowNewTenant(true)}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium transition-all glow-brand"
        >
          <Plus className="w-5 h-5" />
          Create Organization
        </button>
        {showNewTenant && (
          <CreateTenantModal
            onClose={() => setShowNewTenant(false)}
            onCreate={async (name, slug) => {
              const t = await db.createTenant(name, slug);
              setTenants([t]);
              setActiveTenant(t);
              setShowNewTenant(false);
            }}
          />
        )}
      </div>
    );
  }

  const suggestions = [
    "Build a task management app with real-time updates",
    "Create a SaaS dashboard with analytics and billing",
    "Design a landing page with hero, features, and CTA",
    "Build a blog platform with markdown support",
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Main content — centered prompt area */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8">
        {/* Tenant selector — compact */}
        {tenants.length > 1 && (
          <div className="absolute top-4 left-6 flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand-400" />
            <select
              value={activeTenant?.id ?? ""}
              onChange={(e) => {
                const t = tenants.find((x) => x.id === e.target.value);
                if (t) handleSelectTenant(t);
              }}
              className="bg-surface-2 border border-surface-3 text-foreground rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-brand-500"
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Hero heading */}
        <div className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-foreground mb-3">
            What do you want to build?
          </h1>
          <p className="text-slate-400 text-lg max-w-lg mx-auto">
            Describe your idea and Vedaa&apos;s AI agents will build it for you.
          </p>
        </div>

        {/* Prompt input */}
        <div className="w-full max-w-2xl mb-6">
          <div className="relative flex items-end rounded-2xl bg-surface-1 border border-surface-3 focus-within:border-brand-500/50 focus-within:ring-2 focus-within:ring-brand-500/20 transition-all shadow-lg shadow-black/5 dark:shadow-black/20">
            <textarea
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handlePromptSubmit();
                }
              }}
              placeholder="Describe your app in detail..."
              rows={3}
              disabled={creatingProject}
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-slate-500 px-5 py-4 resize-none focus:outline-none disabled:opacity-50 min-h-[80px] max-h-[160px]"
            />
            <button
              onClick={handlePromptSubmit}
              disabled={!promptValue.trim() || creatingProject}
              className="p-3 m-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white transition-all disabled:opacity-30 disabled:hover:bg-brand-600 shrink-0"
            >
              {creatingProject ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
          {promptError && (
            <p className="mt-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 w-full">
              {promptError}
            </p>
          )}
        </div>

        {/* Suggestion cards */}
        <div className="w-full max-w-2xl grid grid-cols-1 sm:grid-cols-2 gap-3">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => setPromptValue(suggestion)}
              className="group text-left px-4 py-3 rounded-xl bg-surface-1/50 border border-surface-3/50 hover:border-brand-500/30 hover:bg-surface-1 transition-all"
            >
              <div className="flex items-start gap-3">
                <Sparkles className="w-4 h-4 text-brand-400 mt-0.5 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity" />
                <span className="text-sm text-slate-400 group-hover:text-foreground transition-colors leading-relaxed">
                  {suggestion}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Recent projects section */}
      {projects.length > 0 && (
        <div className="border-t border-surface-3/50 px-6 py-5 bg-surface-1/30">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                Recent Projects
              </h2>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
              {projects.slice(0, 6).map((project) => (
                <button
                  key={project.id}
                  onClick={() => router.push(`/project/${project.id}?tenant=${activeTenant?.id}`)}
                  className="group shrink-0 w-56 text-left p-4 rounded-xl bg-surface-1/50 border border-surface-3/50 hover:border-brand-500/30 hover:bg-surface-1 transition-all"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 font-mono text-xs font-bold shrink-0">
                      {project.name[0]?.toUpperCase()}
                    </div>
                    <h3 className="text-sm font-medium text-foreground truncate">{project.name}</h3>
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-1 mb-2">
                    {project.description || "No description"}
                  </p>
                  <div className="flex items-center gap-2 text-2xs text-slate-600">
                    <Clock className="w-3 h-3" />
                    {timeAgo(project.updated_at)}
                    {project.stack?.framework && (
                      <span className="px-1.5 py-0.5 rounded bg-surface-3/50 text-slate-500">
                        {project.stack.framework}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showNewTenant && (
        <CreateTenantModal
          onClose={() => setShowNewTenant(false)}
          onCreate={async (name, slug) => {
            const t = await db.createTenant(name, slug);
            setTenants((prev) => [...prev, t]);
            setActiveTenant(t);
            setProjects([]);
            setShowNewTenant(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function CreateTenantModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, slug: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <Modal onClose={onClose} title="Create Organization">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError("");
          try {
            await onCreate(name, slug);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create organization");
            setLoading(false);
          }
        }}
        className="space-y-4"
      >
        <Field label="Organization name" value={name} onChange={setName} placeholder="My Company" required />
        <div className="text-xs text-slate-600 -mt-2 pl-1 font-mono">{slug || "my-company"}</div>
        {error && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading || !name}
          className="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium transition-all disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Create Organization"}
        </button>
      </form>
    </Modal>
  );
}

function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md mx-4 p-6 rounded-2xl bg-surface-1 border border-surface-3 shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-3 text-slate-400 transition-all">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm text-slate-400 mb-1.5">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4 text-foreground placeholder:text-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/50 transition-all"
      />
    </div>
  );
}
