"use client";

import { cn } from "@/lib/utils";
import type { ChatPipelineStage } from "@/types";
import { CheckCircle2, Eye, Code2, FileCode2 } from "lucide-react";

interface BuildSummaryProps {
  files: Array<{ path: string }>;
  stages?: ChatPipelineStage[];
  onOpenPreview: () => void;
  onOpenCode: () => void;
}

export function BuildSummary({ files, stages, onOpenPreview, onOpenCode }: BuildSummaryProps) {
  // Calculate totals from stages
  const totalLatency = stages?.reduce((sum, s) => sum + (s.meta?.latency_ms || 0), 0) || 0;
  const totalCost = stages?.reduce((sum, s) => sum + (s.meta?.cost_usd || 0), 0) || 0;

  return (
    <div className="bg-surface-2 border border-emerald-500/20 rounded-2xl overflow-hidden animate-slide-up">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3/50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <span className="text-sm font-semibold text-foreground">Build Complete</span>
        </div>
        <div className="flex items-center gap-2 text-2xs text-slate-500">
          {totalLatency > 0 && <span>{(totalLatency / 1000).toFixed(1)}s</span>}
          {totalCost > 0 && <span>· ${totalCost.toFixed(3)}</span>}
        </div>
      </div>

      {/* File list */}
      <div className="px-4 py-3">
        <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider mb-2">
          Generated {files.length} file{files.length !== 1 ? "s" : ""}
        </div>
        <div className="space-y-1">
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 py-0.5">
              <FileCode2 className="w-3 h-3 text-slate-500 shrink-0" />
              <span className="text-xs text-slate-300 font-mono truncate">{file.path}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-surface-3/50">
        <button
          onClick={onOpenPreview}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium transition-all",
            "bg-brand-600 hover:bg-brand-700 text-white shadow-sm",
          )}
        >
          <Eye className="w-3 h-3" />
          Open Preview
        </button>
        <button
          onClick={onOpenCode}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all",
            "bg-surface-3 hover:bg-surface-4 text-slate-300",
          )}
        >
          <Code2 className="w-3 h-3" />
          View Code
        </button>
      </div>
    </div>
  );
}
