"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { BuildEvent } from "@/types";
import {
  Brain,
  Code2,
  Shield,
  Rocket,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileCode2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// ActivityTimeline — Compact visual timeline replacing verbose build logs.
// Shows agent activity as a vertical timeline with dot connectors.
// ---------------------------------------------------------------------------

interface ActivityTimelineProps {
  events: BuildEvent[];
  isStreaming: boolean;
}

const AGENT_STYLES: Record<
  string,
  { icon: typeof Brain; color: string; dotColor: string; label: string }
> = {
  analyzer: {
    icon: Brain,
    color: "text-amber-400",
    dotColor: "bg-amber-400",
    label: "Analyzer",
  },
  coder: {
    icon: Code2,
    color: "text-blue-400",
    dotColor: "bg-blue-400",
    label: "Coder",
  },
  reviewer: {
    icon: Shield,
    color: "text-emerald-400",
    dotColor: "bg-emerald-400",
    label: "Reviewer",
  },
  fixer: {
    icon: Rocket,
    color: "text-violet-400",
    dotColor: "bg-violet-400",
    label: "Fixer",
  },
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ActivityTimeline({ events, isStreaming }: ActivityTimelineProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (events.length === 0 && !isStreaming) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        No build activity yet
      </div>
    );
  }

  // Group consecutive events by agent for cleaner display
  const grouped: Array<{
    agent: string;
    events: BuildEvent[];
    startTime: string;
  }> = [];

  for (const evt of events) {
    const agent = evt.agent || "system";
    const lastGroup = grouped[grouped.length - 1];
    if (lastGroup && lastGroup.agent === agent) {
      lastGroup.events.push(evt);
    } else {
      grouped.push({ agent, events: [evt], startTime: evt.created_at });
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4">
        {/* Timeline */}
        <div className="relative pl-6">
          {/* Vertical line */}
          <div className="absolute left-[9px] top-2 bottom-2 w-px bg-surface-3" />

          {grouped.map((group, gi) => {
            const agentStyle = AGENT_STYLES[group.agent] || {
              icon: Code2,
              color: "text-slate-400",
              dotColor: "bg-slate-400",
              label: group.agent,
            };
            const AgentIcon = agentStyle.icon;
            const isLast = gi === grouped.length - 1;
            const isExpanded = expandedIds.has(String(gi));

            // Extract file changes from events
            const fileChanges: string[] = [];
            for (const evt of group.events) {
              const payload = evt.payload as Record<string, unknown>;
              if (payload.file) fileChanges.push(String(payload.file));
              if (payload.files)
                fileChanges.push(
                  ...(payload.files as string[]),
                );
            }
            const uniqueFiles = [...new Set(fileChanges)];

            // Status: last event's kind gives us the state
            const lastEvt = group.events[group.events.length - 1];
            const kind = lastEvt.kind;
            const isSuccess = kind === "done" || kind === "complete" || kind === "success";
            const isError = kind === "error" || kind === "failed";

            return (
              <div key={gi} className="relative mb-4 last:mb-0">
                {/* Dot */}
                <div
                  className={cn(
                    "absolute -left-6 top-0.5 w-[18px] h-[18px] rounded-full border-2 border-surface-0 flex items-center justify-center",
                    isLast && isStreaming
                      ? cn(agentStyle.dotColor, "animate-pulse-dot")
                      : isSuccess
                        ? "bg-emerald-400"
                        : isError
                          ? "bg-red-400"
                          : agentStyle.dotColor,
                  )}
                >
                  {isSuccess ? (
                    <CheckCircle2 className="w-2.5 h-2.5 text-surface-0" />
                  ) : isError ? (
                    <AlertCircle className="w-2.5 h-2.5 text-surface-0" />
                  ) : null}
                </div>

                {/* Content */}
                <div className="min-w-0">
                  {/* Header */}
                  <div className="flex items-center gap-2 mb-0.5">
                    <AgentIcon className={cn("w-3 h-3 shrink-0", agentStyle.color)} />
                    <span className={cn("text-xs font-medium", agentStyle.color)}>
                      {agentStyle.label}
                    </span>
                    <span className="text-2xs text-slate-600">
                      {formatTime(group.startTime)}
                    </span>
                  </div>

                  {/* Summary */}
                  <div className="text-xs text-slate-400 mb-1">
                    {group.events.length === 1
                      ? String(
                          (group.events[0].payload as Record<string, unknown>).message ||
                            group.events[0].kind,
                        ).slice(0, 120)
                      : `${group.events.length} events`}
                  </div>

                  {/* File changes (collapsible) */}
                  {uniqueFiles.length > 0 && (
                    <button
                      onClick={() => toggleExpanded(String(gi))}
                      className="flex items-center gap-1 text-2xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                      <FileCode2 className="w-3 h-3" />
                      {uniqueFiles.length} file{uniqueFiles.length !== 1 ? "s" : ""} changed
                    </button>
                  )}

                  {isExpanded && uniqueFiles.length > 0 && (
                    <div className="mt-1 ml-4 space-y-0.5 animate-fade-in">
                      {uniqueFiles.map((f) => (
                        <div
                          key={f}
                          className="text-2xs text-slate-500 font-mono"
                        >
                          {f}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="relative mt-2">
              <div className="absolute -left-6 top-0.5 flex gap-0.5">
                <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
                <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.2s]" />
                <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.4s]" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
