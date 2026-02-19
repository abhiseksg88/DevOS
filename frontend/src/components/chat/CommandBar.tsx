"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PlanCard } from "@/components/chat/PlanCard";
import { AgentPipeline } from "@/components/chat/AgentPipeline";
import type { ChatMessage, ChatPipelineStage, BuildEvent } from "@/types";
import type { WorkspaceMode } from "@/hooks/useWorkspaceMode";

// ---------------------------------------------------------------------------
// CommandBar — Bottom command palette replacing the left chat panel.
// Single-line input + mode badge + floating plan card.
// ---------------------------------------------------------------------------

interface CommandBarProps {
  onSendMessage: (content: string) => void;
  onApprovePlan: () => void;
  onModifyPlan: (notes: string) => void;
  onRejectPlan: () => void;
  messages: ChatMessage[];
  mode: WorkspaceMode;
  statusLabel: string;
  statusColor: string;
  isStreaming: boolean;
  isAnalyzing: boolean;
  pipelineStages: ChatPipelineStage[];
}

export function CommandBar({
  onSendMessage,
  onApprovePlan,
  onModifyPlan,
  onRejectPlan,
  messages,
  mode,
  statusLabel,
  statusColor,
  isStreaming,
  isAnalyzing,
  pipelineStages,
}: CommandBarProps) {
  const [value, setValue] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Find the latest active plan message (pending or building)
  const pendingPlan = messages.find(
    (m) => m.type === "plan" && (m.planStatus === "pending" || m.planStatus === "building"),
  );

  // Auto-resize textarea (max 3 lines)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 80) + "px";
  }, [value]);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || isAnalyzing) return;
    onSendMessage(trimmed);
    setValue("");
    setShowHistory(false);
  }

  const disabled = isStreaming || isAnalyzing || !!(pendingPlan && pendingPlan.planStatus === "pending");

  return (
    <div className="relative">
      {/* Floating plan card */}
      {pendingPlan?.prd && (
        <div className="absolute bottom-full left-0 right-0 pb-2 px-4 z-20 animate-slide-up">
          <div className="max-w-3xl mx-auto">
            <PlanCard
              prd={pendingPlan.prd}
              status={pendingPlan.planStatus || "pending"}
              onApprove={onApprovePlan}
              onModify={onModifyPlan}
              onReject={onRejectPlan}
              disabled={disabled}
            />
          </div>
        </div>
      )}

      {/* Pipeline dots — compact horizontal display during build */}
      {pipelineStages.length > 0 && mode === "build" && (
        <div className="absolute bottom-full left-0 right-0 pb-1 px-4 z-10">
          <div className="max-w-3xl mx-auto">
            <AgentPipeline stages={pipelineStages} compact />
          </div>
        </div>
      )}

      {/* Collapsible message history */}
      {showHistory && (
        <div className="absolute bottom-full left-0 right-0 max-h-64 overflow-y-auto bg-surface-1 border-t border-surface-3 animate-slide-up">
          <div className="max-w-3xl mx-auto py-2 px-4 space-y-2">
            {messages
              .filter((m) => m.type !== "pipeline" && m.role !== "system")
              .slice(-10)
              .map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "text-xs px-3 py-1.5 rounded-lg max-w-[80%]",
                    m.role === "user"
                      ? "bg-brand-500/10 text-brand-400 ml-auto"
                      : "bg-surface-2 text-slate-400",
                  )}
                >
                  {m.content.slice(0, 200)}
                  {m.content.length > 200 ? "..." : ""}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Main command bar */}
      <div className="border-t border-surface-3 bg-surface-1 px-4 py-2">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          {/* History toggle */}
          {messages.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all shrink-0 mb-0.5"
              title={showHistory ? "Hide history" : "Show history"}
            >
              {showHistory ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
            </button>
          )}

          {/* Mode badge */}
          {statusLabel && (
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-2xs font-medium shrink-0 mb-0.5",
                statusColor,
              )}
            >
              {(mode === "build" || mode === "plan" || mode === "awaiting_approval") && (
                <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-dot" />
              )}
              {statusLabel}
            </div>
          )}

          {/* Input */}
          <div className="flex-1 relative flex items-end rounded-xl bg-surface-2 border border-surface-3 focus-within:border-brand-500/50 focus-within:ring-1 focus-within:ring-brand-500/30 transition-all">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={
                disabled
                  ? pendingPlan && pendingPlan.planStatus === "pending"
                    ? "Review the plan above..."
                    : statusLabel ? `${statusLabel}...` : "Building..."
                  : "Describe what you want to build..."
              }
              disabled={disabled}
              rows={1}
              className="flex-1 bg-transparent text-foreground text-sm placeholder:text-slate-600 px-4 py-2.5 resize-none focus:outline-none disabled:opacity-50 max-h-[80px]"
            />
            <button
              onClick={handleSubmit}
              disabled={disabled || !value.trim()}
              className="p-2 m-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-all disabled:opacity-30 disabled:hover:bg-brand-600 shrink-0"
            >
              {disabled ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
