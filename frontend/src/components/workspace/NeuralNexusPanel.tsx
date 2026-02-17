"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  X,
  Activity,
  Shield,
  Code2,
  User,
  ChevronDown,
  ChevronRight,
  Zap,
  AlertTriangle,
  CheckCircle,
  Clock,
  TrendingUp,
  Target,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import type {
  NexusState,
  NexusAgentExecution,
  NexusTechDebt,
  NexusBusinessLogic,
} from "@/types";

// ---------------------------------------------------------------------------
// Agent role config — icons, colors, labels
// ---------------------------------------------------------------------------

const AGENT_CONFIG: Record<
  string,
  { label: string; icon: typeof Brain; color: string; bgColor: string }
> = {
  shadow_cto: {
    label: "Shadow CTO",
    icon: Brain,
    color: "text-purple-400",
    bgColor: "bg-purple-500/10",
  },
  staff_engineer: {
    label: "Staff Engineer",
    icon: Layers,
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
  },
  principal_builder: {
    label: "Principal Builder",
    icon: Code2,
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
  },
  red_team_sentinel: {
    label: "Red Team Sentinel",
    icon: Shield,
    color: "text-red-400",
    bgColor: "bg-red-500/10",
  },
  devops_lead: {
    label: "DevOps Lead",
    icon: Zap,
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  color = "text-white",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-surface-2 rounded-xl border border-surface-3 p-3">
      <p className="text-2xs text-slate-500 font-medium uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={cn("text-lg font-bold", color)}>{value}</p>
      {sub && <p className="text-2xs text-slate-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function HealthBar({ score }: { score: number }) {
  const color =
    score >= 80
      ? "bg-emerald-500"
      : score >= 60
        ? "bg-amber-500"
        : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-surface-3 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs font-mono text-slate-400">{score}</span>
    </div>
  );
}

function AgentActivityItem({ exec }: { exec: NexusAgentExecution }) {
  const config = AGENT_CONFIG[exec.agent_role] ?? {
    label: exec.agent_role,
    icon: Activity,
    color: "text-slate-400",
    bgColor: "bg-surface-3",
  };
  const Icon = config.icon;
  const isRunning = exec.status === "running";
  const isFailed = exec.status === "failed" || exec.status === "rejected";

  return (
    <div className="flex items-start gap-2.5 py-2 px-1 border-b border-surface-3/50 last:border-0">
      <div
        className={cn(
          "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
          config.bgColor
        )}
      >
        <Icon className={cn("w-3.5 h-3.5", config.color)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-slate-300">
            {config.label}
          </span>
          <span className="text-2xs text-slate-600">{exec.agent_step}</span>
          {isRunning && (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
          )}
          {isFailed && (
            <AlertTriangle className="w-3 h-3 text-red-400" />
          )}
          {exec.status === "succeeded" && (
            <CheckCircle className="w-3 h-3 text-emerald-400" />
          )}
        </div>
        {exec.output_summary && (
          <p className="text-2xs text-slate-500 mt-0.5 truncate">
            {exec.output_summary}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1 text-2xs text-slate-600">
          <span className="font-mono">{exec.model_tier}</span>
          {exec.latency_ms > 0 && <span>{(exec.latency_ms / 1000).toFixed(1)}s</span>}
          {exec.cost_usd > 0 && <span>${exec.cost_usd.toFixed(4)}</span>}
        </div>
      </div>
    </div>
  );
}

function TechDebtItem({ debt }: { debt: NexusTechDebt }) {
  const severityColor =
    debt.severity === "critical"
      ? "text-red-400 bg-red-500/10"
      : debt.severity === "high"
        ? "text-orange-400 bg-orange-500/10"
        : debt.severity === "medium"
          ? "text-amber-400 bg-amber-500/10"
          : "text-slate-400 bg-surface-3";

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-surface-3/50 last:border-0">
      <span
        className={cn(
          "text-2xs font-medium px-1.5 py-0.5 rounded-md shrink-0 uppercase",
          severityColor
        )}
      >
        {debt.severity}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-400 truncate">{debt.description}</p>
        <p className="text-2xs text-slate-600 font-mono mt-0.5">{debt.file}</p>
      </div>
    </div>
  );
}

function BusinessLogicItem({ entry }: { entry: NexusBusinessLogic }) {
  return (
    <div className="py-1.5 border-b border-surface-3/50 last:border-0">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-brand-400 font-mono">{entry.entity_type}</span>
        <span className="text-xs text-slate-300 font-medium">{entry.entity_name}</span>
      </div>
      <p className="text-2xs text-slate-500 mt-0.5">{entry.purpose}</p>
      {entry.domain && (
        <span className="text-2xs text-slate-600 mt-0.5 inline-block">
          Domain: {entry.domain}
        </span>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  icon: Icon,
  children,
  defaultOpen = false,
  badge,
}: {
  title: string;
  icon: typeof Brain;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-surface-3">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
        )}
        <Icon className="w-3.5 h-3.5 text-brand-400" />
        <span className="text-xs font-medium text-slate-300 flex-1">
          {title}
        </span>
        {badge !== undefined && (
          <span className="text-2xs text-slate-500 bg-surface-3 px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

interface NeuralNexusPanelProps {
  projectId: string;
  tenantId: string;
  token: string;
  open: boolean;
  onClose: () => void;
}

export function NeuralNexusPanel({
  projectId,
  tenantId,
  token,
  open,
  onClose,
}: NeuralNexusPanelProps) {
  const [state, setState] = useState<NexusState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    if (!token || !tenantId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.nexus.getState(token, tenantId, projectId);
      setState(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load Neural Nexus";
      const lower = msg.toLowerCase();
      const isNetworkError = lower.includes("cannot reach") ||
                             lower.includes("unreachable") ||
                             lower.includes("cors") ||
                             lower.includes("failed to fetch") ||
                             lower.includes("networkerror") ||
                             lower.includes("network") ||
                             lower.includes("econnrefused") ||
                             lower.includes("load failed") ||
                             lower.includes("fetch") ||
                             lower.includes("api_url");
      setError(isNetworkError ? "__NOT_CONNECTED__" : msg);
    } finally {
      setLoading(false);
    }
  }, [token, tenantId, projectId]);

  useEffect(() => {
    if (open) loadState();
  }, [open, loadState]);

  if (!open) return null;

  const persona = state?.user_persona;
  const psm = state?.project_state;
  const activity = state?.agent_activity ?? [];
  const techDebt = psm?.tech_debt ?? [];
  const businessLogic = state?.business_logic ?? [];
  const fileCount = Object.keys(psm?.file_graph ?? {}).length;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed top-0 right-0 bottom-0 w-[420px] bg-surface-1 border-l border-surface-3 z-50 flex flex-col animate-slide-in-right shadow-2xl">
        {/* Header */}
        <div className="h-12 border-b border-surface-3 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand-500/10 border border-brand-500/20 flex items-center justify-center">
              <Brain className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Neural Nexus</h2>
              <p className="text-2xs text-slate-500">The Brain — Shared State Engine</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-surface-3 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && !state && (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-brand-500/20 border-t-brand-500 rounded-full animate-spin" />
            </div>
          )}

          {error && error === "__NOT_CONNECTED__" && (
            <div className="m-4 p-4 bg-surface-2 border border-surface-3 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium text-slate-300">
                  Backend Not Connected
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed mb-3">
                Neural Nexus requires the FastAPI backend to be running.
                It will learn your preferences, track project health, and make every
                generation smarter over time.
              </p>
              <div className="space-y-2 text-2xs text-slate-600">
                <p className="font-medium text-slate-400">To enable Neural Nexus:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Deploy the <code className="bg-surface-3 px-1 rounded text-slate-400">nimbusforge/</code> backend to Railway or similar</li>
                  <li>Set <code className="bg-surface-3 px-1 rounded text-slate-400">NEXT_PUBLIC_API_URL</code> in your deployment env vars</li>
                  <li>Ensure CORS allows requests from this origin</li>
                </ol>
              </div>
              <button
                onClick={loadState}
                className="mt-3 text-xs text-brand-400 hover:text-brand-300 font-medium transition-colors"
              >
                Retry Connection
              </button>
            </div>
          )}

          {error && error !== "__NOT_CONNECTED__" && (
            <div className="m-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
              {error}
            </div>
          )}

          {state && (
            <>
              {/* Health & Stats Overview */}
              <div className="p-4 border-b border-surface-3">
                <div className="flex items-center gap-2 mb-3">
                  <Target className="w-3.5 h-3.5 text-brand-400" />
                  <span className="text-xs font-medium text-slate-300">
                    Project Health
                  </span>
                </div>
                <HealthBar score={psm?.health_score ?? 100} />

                <div className="grid grid-cols-3 gap-2 mt-3">
                  <StatCard
                    label="Files"
                    value={fileCount}
                    color="text-blue-400"
                  />
                  <StatCard
                    label="Prompts"
                    value={persona?.stats.total_prompts ?? 0}
                    color="text-brand-400"
                  />
                  <StatCard
                    label="Accept Rate"
                    value={
                      persona?.stats.acceptance_rate
                        ? `${(persona.stats.acceptance_rate * 100).toFixed(0)}%`
                        : "—"
                    }
                    color="text-emerald-400"
                  />
                </div>
              </div>

              {/* Agent Activity Feed */}
              <CollapsibleSection
                title="Agent Activity"
                icon={Activity}
                defaultOpen={true}
                badge={activity.length}
              >
                {activity.length === 0 ? (
                  <p className="text-2xs text-slate-600 py-2">
                    No agent activity yet. Send a prompt to activate the swarm.
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto">
                    {activity.map((exec) => (
                      <AgentActivityItem key={exec.id} exec={exec} />
                    ))}
                  </div>
                )}
              </CollapsibleSection>

              {/* User Persona Protocol */}
              <CollapsibleSection
                title="User Persona Protocol"
                icon={User}
                badge={
                  Object.keys(persona?.preferences ?? {}).length +
                  Object.keys(persona?.expertise ?? {}).length
                }
              >
                {/* Expertise */}
                {Object.keys(persona?.expertise ?? {}).length > 0 && (
                  <div className="mb-3">
                    <p className="text-2xs text-slate-500 font-medium uppercase tracking-wider mb-1.5">
                      Expertise Levels
                    </p>
                    <div className="space-y-1">
                      {Object.entries(persona?.expertise ?? {}).map(
                        ([domain, level]) => (
                          <div
                            key={domain}
                            className="flex items-center justify-between text-xs"
                          >
                            <span className="text-slate-400 capitalize">
                              {domain}
                            </span>
                            <span
                              className={cn(
                                "text-2xs font-medium px-1.5 py-0.5 rounded-md",
                                level === "expert"
                                  ? "text-emerald-400 bg-emerald-500/10"
                                  : level === "intermediate"
                                    ? "text-blue-400 bg-blue-500/10"
                                    : "text-amber-400 bg-amber-500/10"
                              )}
                            >
                              {level}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

                {/* Preferences */}
                {Object.keys(persona?.preferences ?? {}).length > 0 && (
                  <div>
                    <p className="text-2xs text-slate-500 font-medium uppercase tracking-wider mb-1.5">
                      Learned Preferences
                    </p>
                    <div className="space-y-1">
                      {Object.entries(persona?.preferences ?? {}).map(
                        ([key, value]) => (
                          <div
                            key={key}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="text-slate-500 font-mono">
                              {key}:
                            </span>
                            <span className="text-slate-300 truncate">
                              {typeof value === "object"
                                ? JSON.stringify(value)
                                : String(value)}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

                {Object.keys(persona?.preferences ?? {}).length === 0 &&
                  Object.keys(persona?.expertise ?? {}).length === 0 && (
                    <p className="text-2xs text-slate-600 py-2">
                      The Nexus will learn your preferences as you interact.
                      Accept or reject generated code to teach it.
                    </p>
                  )}
              </CollapsibleSection>

              {/* Technical Debt */}
              <CollapsibleSection
                title="Technical Debt Register"
                icon={AlertTriangle}
                badge={techDebt.length}
              >
                {techDebt.length === 0 ? (
                  <p className="text-2xs text-slate-600 py-2">
                    No technical debt detected. The Red Team Sentinel will flag
                    issues as they appear.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {techDebt.map((debt, i) => (
                      <TechDebtItem key={i} debt={debt} />
                    ))}
                  </div>
                )}
              </CollapsibleSection>

              {/* Business Logic */}
              <CollapsibleSection
                title="Business Logic Map"
                icon={TrendingUp}
                badge={businessLogic.length}
              >
                {businessLogic.length === 0 ? (
                  <p className="text-2xs text-slate-600 py-2">
                    Business logic entries will be inferred by the Shadow CTO as
                    you build your application.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {businessLogic.map((entry, i) => (
                      <BusinessLogicItem key={i} entry={entry} />
                    ))}
                  </div>
                )}
              </CollapsibleSection>

              {/* File Graph Summary */}
              <CollapsibleSection
                title="Project State Matrix"
                icon={Layers}
                badge={fileCount}
              >
                {fileCount === 0 ? (
                  <p className="text-2xs text-slate-600 py-2">
                    Generate code to populate the project state matrix.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {Object.entries(psm?.file_graph ?? {}).map(
                      ([path, info]) => (
                        <div
                          key={path}
                          className="flex items-center justify-between text-2xs py-1 border-b border-surface-3/30 last:border-0"
                        >
                          <span className="text-slate-400 font-mono truncate flex-1">
                            {path}
                          </span>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <span className="text-slate-600">
                              {info.lines}L
                            </span>
                            <span
                              className={cn(
                                "px-1 py-0.5 rounded text-2xs",
                                info.complexity === "high"
                                  ? "text-red-400 bg-red-500/10"
                                  : info.complexity === "medium"
                                    ? "text-amber-400 bg-amber-500/10"
                                    : "text-emerald-400 bg-emerald-500/10"
                              )}
                            >
                              {info.complexity}
                            </span>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </CollapsibleSection>

              {/* Recent Decisions */}
              {(persona?.history ?? []).length > 0 && (
                <CollapsibleSection
                  title="Decision History"
                  icon={Clock}
                  badge={persona?.history.length}
                >
                  <div className="max-h-36 overflow-y-auto space-y-1.5">
                    {persona?.history.map((h, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1.5 text-2xs py-1"
                      >
                        <span
                          className={cn(
                            "shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full",
                            h.outcome === "success"
                              ? "bg-emerald-500"
                              : "bg-red-500"
                          )}
                        />
                        <div>
                          <span className="text-slate-400">{h.decision}</span>
                          {h.reason && (
                            <span className="text-slate-600 ml-1">
                              ({h.reason})
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="h-10 border-t border-surface-3 flex items-center justify-between px-4 shrink-0">
          <span className="text-2xs text-slate-600">
            Flywheel: Every interaction makes the Nexus smarter
          </span>
          <button
            onClick={loadState}
            className="text-2xs text-brand-400 hover:text-brand-300 font-medium transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>
    </>
  );
}
