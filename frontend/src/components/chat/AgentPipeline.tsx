"use client";

import { cn } from "@/lib/utils";
import type { ChatPipelineStage } from "@/types";
import {
  Brain,
  Code2,
  Shield,
  Rocket,
  CheckCircle2,
  XCircle,
  Loader2,
  Minus,
} from "lucide-react";

const STAGE_ICONS: Record<string, typeof Brain> = {
  plan: Brain,
  code: Code2,
  review: Shield,
  fix: Rocket,
};

interface AgentPipelineProps {
  stages: ChatPipelineStage[];
  compact?: boolean;
}

export function AgentPipeline({ stages, compact }: AgentPipelineProps) {
  if (stages.length === 0) return null;

  return (
    <div
      className={cn(
        "animate-slide-up",
        compact ? "py-2" : "bg-surface-2 border border-surface-3 rounded-2xl px-4 py-4",
      )}
    >
      {!compact && (
        <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider mb-3">
          Agent Pipeline
        </div>
      )}

      <div className="flex items-start justify-between gap-1">
        {stages.map((stage, i) => {
          const Icon = STAGE_ICONS[stage.key] || Code2;
          const isLast = i === stages.length - 1;

          return (
            <div key={stage.key} className="flex items-center flex-1 min-w-0">
              {/* Stage */}
              <div className="flex flex-col items-center gap-1 min-w-0">
                {/* Circle */}
                <div
                  className={cn(
                    "shrink-0 rounded-full flex items-center justify-center transition-all",
                    compact ? "w-6 h-6" : "w-8 h-8",
                    stage.status === "done" && "bg-emerald-500/20 text-emerald-400",
                    stage.status === "active" && "bg-brand-500/20 text-brand-400",
                    stage.status === "error" && "bg-red-500/20 text-red-400",
                    stage.status === "skipped" && "bg-slate-500/10 text-slate-600",
                    stage.status === "pending" && "bg-surface-3 text-slate-600",
                  )}
                >
                  {stage.status === "done" ? (
                    <CheckCircle2 className={cn(compact ? "w-3 h-3" : "w-4 h-4")} />
                  ) : stage.status === "active" ? (
                    <Loader2 className={cn(compact ? "w-3 h-3" : "w-4 h-4", "animate-spin")} />
                  ) : stage.status === "error" ? (
                    <XCircle className={cn(compact ? "w-3 h-3" : "w-4 h-4")} />
                  ) : stage.status === "skipped" ? (
                    <Minus className={cn(compact ? "w-3 h-3" : "w-4 h-4")} />
                  ) : (
                    <Icon className={cn(compact ? "w-3 h-3" : "w-4 h-4")} />
                  )}
                </div>

                {/* Label */}
                <span
                  className={cn(
                    "font-medium text-center truncate w-full",
                    compact ? "text-2xs" : "text-xs",
                    stage.status === "done" && "text-emerald-400",
                    stage.status === "active" && "text-foreground",
                    stage.status === "error" && "text-red-400",
                    (stage.status === "pending" || stage.status === "skipped") && "text-slate-600",
                  )}
                >
                  {stage.label}
                </span>

                {/* Agent + meta */}
                {!compact && (
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-2xs text-slate-600">{stage.agent}</span>
                    {stage.meta?.latency_ms && stage.status === "done" && (
                      <span className="text-2xs text-slate-700">
                        {(stage.meta.latency_ms / 1000).toFixed(1)}s
                        {stage.meta.cost_usd ? ` · $${stage.meta.cost_usd.toFixed(3)}` : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={cn(
                    "flex-1 h-px mx-1 transition-all",
                    compact ? "mt-[-12px]" : "mt-[-24px]",
                    stage.status === "done" ? "bg-emerald-500/40" : "bg-surface-3",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
