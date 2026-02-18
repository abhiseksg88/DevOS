"use client";

import type { ChatMessage } from "@/types";
import { cn } from "@/lib/utils";
import { User, Bot, CheckCircle2, Circle, XCircle, Loader2 } from "lucide-react";
import { PlanCard } from "./PlanCard";
import { AgentPipeline } from "./AgentPipeline";
import { BuildSummary } from "./BuildSummary";

const STATUS_CONFIG: Record<string, { color: string; icon: typeof Circle; label: string }> = {
  queued: { color: "text-slate-400", icon: Circle, label: "Queued" },
  planning: { color: "text-blue-400", icon: Loader2, label: "Planning" },
  scaffolding: { color: "text-blue-400", icon: Loader2, label: "Scaffolding" },
  coding: { color: "text-amber-400", icon: Loader2, label: "Coding" },
  reviewing: { color: "text-violet-400", icon: Loader2, label: "Reviewing" },
  building: { color: "text-orange-400", icon: Loader2, label: "Building" },
  deploying: { color: "text-cyan-400", icon: Loader2, label: "Deploying" },
  succeeded: { color: "text-emerald-400", icon: CheckCircle2, label: "Succeeded" },
  failed: { color: "text-red-400", icon: XCircle, label: "Failed" },
  cancelled: { color: "text-slate-500", icon: XCircle, label: "Cancelled" },
};

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onApprovePlan?: () => void;
  onModifyPlan?: (notes: string) => void;
  onRejectPlan?: () => void;
  onOpenPreview?: () => void;
  onOpenCode?: () => void;
}

export function ChatMessageBubble({
  message,
  onApprovePlan,
  onModifyPlan,
  onRejectPlan,
  onOpenPreview,
  onOpenCode,
}: ChatMessageBubbleProps) {
  // Rich message: Plan Card
  if (message.type === "plan" && message.prd) {
    return (
      <div className="animate-slide-up px-1">
        <PlanCard
          prd={message.prd}
          status={message.planStatus ?? "pending"}
          onApprove={onApprovePlan ?? (() => {})}
          onModify={onModifyPlan ?? (() => {})}
          onReject={onRejectPlan ?? (() => {})}
          disabled={message.planStatus === "building" || message.planStatus === "completed"}
        />
      </div>
    );
  }

  // Rich message: Agent Pipeline
  if (message.type === "pipeline" && message.pipelineStages) {
    return (
      <div className="animate-slide-up px-1">
        <AgentPipeline stages={message.pipelineStages} />
      </div>
    );
  }

  // Rich message: Build Summary
  if (message.type === "summary" && message.buildFiles) {
    return (
      <div className="animate-slide-up px-1">
        <BuildSummary
          files={message.buildFiles}
          stages={message.pipelineStages}
          onOpenPreview={onOpenPreview ?? (() => {})}
          onOpenCode={onOpenCode ?? (() => {})}
        />
      </div>
    );
  }

  // Default: text bubble
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-3 animate-slide-up", isUser ? "flex-row-reverse" : "")}>
      {/* Avatar */}
      <div
        className={cn(
          "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
          isUser
            ? "bg-brand-500/20 border border-brand-500/30"
            : "bg-emerald-500/10 border border-emerald-500/20"
        )}
      >
        {isUser ? (
          <User className="w-3.5 h-3.5 text-brand-400" />
        ) : (
          <Bot className="w-3.5 h-3.5 text-emerald-400" />
        )}
      </div>

      {/* Message */}
      <div className={cn("flex-1 min-w-0", isUser ? "text-right" : "")}>
        <div
          className={cn(
            "inline-block text-sm leading-relaxed rounded-2xl px-4 py-2.5 max-w-[90%]",
            isUser
              ? "bg-brand-600 text-white rounded-tr-md"
              : "bg-surface-2 text-slate-200 rounded-tl-md border border-surface-3"
          )}
        >
          {message.content}
        </div>

        {/* Build status badge */}
        {message.status && (
          <div className="mt-2">
            <BuildStatusBadge status={message.status} />
          </div>
        )}

        <div className="mt-1 text-2xs text-slate-600">
          {new Date(message.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}

function BuildStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.queued;
  const Icon = config.icon;
  const isSpinning = [Loader2].includes(Icon);

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium border",
        config.color
      )}
      style={{
        backgroundColor: `color-mix(in srgb, currentColor 8%, transparent)`,
        borderColor: `color-mix(in srgb, currentColor 20%, transparent)`,
      }}
    >
      <Icon className={cn("w-3 h-3", isSpinning && "animate-spin")} />
      {config.label}
    </div>
  );
}
