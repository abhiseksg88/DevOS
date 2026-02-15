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
} from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewTenant, setShowNewTenant] = useState(false);

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
        <h1 className="text-2xl font-bold text-white mb-3">Database Setup Required</h1>
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
        <h1 className="text-3xl font-bold text-white mb-3">Welcome to Vedaa</h1>
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

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      {/* Tenant selector */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Layers className="w-5 h-5 text-brand-400" />
          <select
            value={activeTenant?.id ?? ""}
            onChange={(e) => {
              const t = tenants.find((x) => x.id === e.target.value);
              if (t) handleSelectTenant(t);
            }}
            className="bg-surface-2 border border-surface-4 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="text-xs px-2 py-0.5 rounded-full bg-brand-500/10 text-brand-400 border border-brand-500/20 uppercase tracking-wider font-medium">
            {activeTenant?.plan}
          </span>
        </div>
        <button
          onClick={() => setShowNewProject(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-all glow-brand"
        >
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Project grid */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <FolderOpen className="w-12 h-12 text-slate-600 mb-4" />
          <p className="text-slate-400 mb-2">No projects yet</p>
          <p className="text-slate-600 text-sm">Create your first project to start building</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => router.push(`/project/${project.id}?tenant=${activeTenant?.id}`)}
              className="group text-left p-5 rounded-2xl glass glass-hover gradient-border transition-all duration-300"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center text-brand-400 font-mono text-sm font-bold">
                  {project.name[0]?.toUpperCase()}
                </div>
                <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-brand-400 transition-colors" />
              </div>
              <h3 className="text-white font-semibold mb-1">{project.name}</h3>
              <p className="text-slate-500 text-sm line-clamp-2 mb-4">
                {project.description || "No description"}
              </p>
              <div className="flex items-center gap-3 text-xs text-slate-600">
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {timeAgo(project.updated_at)}
                </div>
                {project.stack?.framework && (
                  <span className="px-2 py-0.5 rounded-full bg-surface-3 text-slate-400">
                    {project.stack.framework}
                  </span>
                )}
                <span
                  className={cn(
                    "px-2 py-0.5 rounded-full text-2xs font-medium uppercase tracking-wider",
                    project.status === "active"
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-slate-500/10 text-slate-400"
                  )}
                >
                  {project.status}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Modals */}
      {showNewProject && activeTenant && (
        <CreateProjectModal
          onClose={() => setShowNewProject(false)}
          onCreate={async (name, slug, description) => {
            const p = await db.createProject(
              activeTenant.id,
              name,
              slug,
              description,
              { framework: "nextjs", language: "typescript" }
            );
            setProjects((prev) => [p, ...prev]);
            setShowNewProject(false);
            router.push(`/project/${p.id}?tenant=${activeTenant.id}`);
          }}
        />
      )}

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

function CreateProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, slug: string, description: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <Modal onClose={onClose} title="New Project">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setLoading(true);
          setError("");
          try {
            await onCreate(name, slug, desc);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create project");
            setLoading(false);
          }
        }}
        className="space-y-4"
      >
        <Field label="Project name" value={name} onChange={setName} placeholder="My Awesome App" required />
        <div className="text-xs text-slate-600 -mt-2 pl-1 font-mono">{slug || "my-awesome-app"}</div>
        <Field label="Description" value={desc} onChange={setDesc} placeholder="A brief description..." />
        {error && (
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading || !name}
          className="w-full py-3 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-medium transition-all disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "Create Project"}
        </button>
      </form>
    </Modal>
  );
}

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
          <h3 className="text-lg font-semibold text-white">{title}</h3>
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
        className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/50 transition-all"
      />
    </div>
  );
}
