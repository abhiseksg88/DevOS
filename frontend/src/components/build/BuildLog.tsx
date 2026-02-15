"use client";

import { useRef, useEffect } from "react";
import type { BuildEvent, BuildStatus } from "@/types";
import { cn } from "@/lib/utils";
import {
  Terminal,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Cpu,
  FileCode2,
  Shield,
  Rocket,
  Lightbulb,
} from "lucide-react";

const KIND_CONFIG: Record<string, { icon: typeof Terminal; color: string }> = {
  log: { icon: Terminal, color: "text-slate-400" },
  agent_start: { icon: Cpu, color: "text-blue-400" },
  agent_end: { icon: CheckCircle2, color: "text-emerald-400" },
  patch: { icon: FileCode2, color: "text-amber-400" },
  test_result: { icon: Shield, color: "text-violet-400" },
  build_progress: { icon: Loader2, color: "text-orange-400" },
  deploy_progress: { icon: Rocket, color: "text-cyan-400" },
  error: { icon: XCircle, color: "text-red-400" },
  warning: { icon: AlertTriangle, color: "text-amber-400" },
  info: { icon: Lightbulb, color: "text-blue-400" },
};

interface BuildLogProps {
  events: BuildEvent[];
  isStreaming: boolean;
  status: BuildStatus | null;
}

export function BuildLog({ events, isStreaming, status }: BuildLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Header */}
      <div className="h-8 flex items-center justify-between px-3 border-b border-surface-3 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-2xs font-medium text-slate-500 uppercase tracking-wider">
            Build Output
          </span>
        </div>
        {status && (
          <div
            className={cn(
              "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium",
              status === "succeeded"
                ? "bg-emerald-500/10 text-emerald-400"
                : status === "failed"
                ? "bg-red-500/10 text-red-400"
                : "bg-amber-500/10 text-amber-400"
            )}
          >
            {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
            {status}
          </div>
        )}
      </div>

      {/* Log entries */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {events.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600">
            <Terminal className="w-8 h-8 mb-3 opacity-30" />
            <p>No build output yet</p>
            <p className="text-2xs mt-1">Send a prompt to start a build</p>
          </div>
        )}

        {events.length === 0 && isStreaming && (
          <div className="flex items-center gap-2 text-slate-500 animate-pulse-dot">
            <Loader2 className="w-3 h-3 animate-spin" />
            Waiting for build events...
          </div>
        )}

        {events.map((event, i) => {
          const config = KIND_CONFIG[event.kind] ?? KIND_CONFIG.log;
          const Icon = config.icon;
          const message =
            (event.payload?.message as string) ??
            (event.payload?.diff as string) ??
            event.kind;

          return (
            <div
              key={i}
              className="flex items-start gap-2 py-1 animate-slide-up border-b border-surface-2/50 last:border-0"
            >
              {/* Seq number */}
              <span className="text-slate-700 w-6 text-right shrink-0 select-none">
                {event.seq}
              </span>

              {/* Icon */}
              <Icon
                className={cn(
                  "w-3.5 h-3.5 mt-0.5 shrink-0",
                  config.color,
                  Icon === Loader2 && "animate-spin"
                )}
              />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {event.agent && (
                    <span
                      className={cn(
                        "px-1.5 py-0 rounded text-2xs font-medium uppercase tracking-wider",
                        event.agent === "opus"
                          ? "bg-violet-500/10 text-violet-400"
                          : event.agent === "sonnet"
                          ? "bg-blue-500/10 text-blue-400"
                          : event.agent === "haiku"
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-slate-500/10 text-slate-400"
                      )}
                    >
                      {event.agent}
                    </span>
                  )}
                  <span className="text-2xs text-slate-700">
                    {new Date(event.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </div>
                <pre
                  className={cn(
                    "mt-0.5 whitespace-pre-wrap break-words leading-relaxed",
                    config.color
                  )}
                >
                  {message}
                </pre>
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {isStreaming && events.length > 0 && (
          <div className="flex items-center gap-2 py-2 text-brand-400">
            <div className="flex gap-1">
              <div className="w-1 h-1 rounded-full bg-brand-400 animate-pulse-dot" />
              <div className="w-1 h-1 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.3s]" />
              <div className="w-1 h-1 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.6s]" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
