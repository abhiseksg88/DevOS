"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Brain,
  CheckCircle2,
  Loader2,
  Pencil,
  Play,
  X,
  Database,
  FileCode2,
  Sparkles,
} from "lucide-react";

interface PlanCardProps {
  prd: Record<string, unknown>;
  status: "pending" | "approved" | "modified" | "building" | "completed";
  onApprove: () => void;
  onModify: (notes: string) => void;
  onReject: () => void;
  disabled?: boolean;
}

export function PlanCard({ prd, status, onApprove, onModify, onReject, disabled }: PlanCardProps) {
  const [showModify, setShowModify] = useState(false);
  const [notes, setNotes] = useState("");

  const intent = (prd.intent as string) || "build";
  const summary = (prd.summary as string) || "Analyzing your request...";
  const changes = (prd.changes as Array<{ type: string; file: string; description: string }>) || [];
  const newComponents = (prd.new_components as Array<{ name: string; description: string }>) || [];
  const dataModel = prd.data_model as Record<string, { fields: string[] }> | undefined;
  const integrationNotes = prd.integration_notes as string | undefined;

  const allItems = [
    ...changes.map((c) => ({ icon: FileCode2, text: `${c.type} ${c.file}`, detail: c.description })),
    ...newComponents.map((c) => ({ icon: Sparkles, text: `Create ${c.name}`, detail: c.description })),
  ];

  const isInteractive = status === "pending" && !disabled;
  const isBuilding = status === "building";
  const isDone = status === "completed";

  const handleModifySubmit = () => {
    if (notes.trim()) {
      onModify(notes.trim());
      setNotes("");
      setShowModify(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-2xl border overflow-hidden animate-slide-up transition-all",
        isDone
          ? "bg-emerald-500/5 border-emerald-500/20"
          : isBuilding
          ? "bg-brand-500/5 border-brand-500/30 animate-pulse"
          : "bg-surface-2 border-surface-3",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3/50">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "w-7 h-7 rounded-lg flex items-center justify-center",
              isDone
                ? "bg-emerald-500/20 text-emerald-400"
                : isBuilding
                ? "bg-brand-500/20 text-brand-400"
                : "bg-blue-500/20 text-blue-400",
            )}
          >
            {isDone ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : isBuilding ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Brain className="w-4 h-4" />
            )}
          </div>
          <span className="text-sm font-semibold text-foreground">
            {isDone ? "Plan Completed" : isBuilding ? "Building..." : "Build Plan"}
          </span>
        </div>
        <span
          className={cn(
            "px-2 py-0.5 rounded-full text-2xs font-medium uppercase tracking-wider",
            intent === "build_new"
              ? "bg-brand-500/10 text-brand-400"
              : intent === "fix_bug"
              ? "bg-red-500/10 text-red-400"
              : intent === "add_feature"
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-slate-500/10 text-slate-400",
          )}
        >
          {intent.replace(/_/g, " ")}
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        {/* Summary */}
        <p className="text-sm text-slate-300 leading-relaxed">{summary}</p>

        {/* Action Items */}
        {allItems.length > 0 && (
          <div className="space-y-1">
            <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
              What will be built
            </div>
            {allItems.map((item, i) => {
              const Icon = item.icon;
              return (
                <div key={i} className="flex items-start gap-2 py-1">
                  <Icon className="w-3.5 h-3.5 text-brand-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-slate-200">{item.text}</span>
                    {item.detail && (
                      <span className="text-xs text-slate-500 ml-1.5">— {item.detail}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Data Model */}
        {dataModel && Object.keys(dataModel).length > 0 && (
          <div>
            <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
              Data Model
            </div>
            {Object.entries(dataModel).map(([name, schema]) => (
              <div key={name} className="flex items-start gap-2 py-1">
                <Database className="w-3.5 h-3.5 text-cyan-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <span className="text-xs font-medium text-slate-200">{name}</span>
                  <span className="text-xs text-slate-500 ml-1.5">
                    — {schema.fields?.join(", ") || "flexible schema"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Integration Notes */}
        {integrationNotes && (
          <p className="text-xs text-slate-500 italic">{integrationNotes}</p>
        )}

        {/* Modify Textarea */}
        {showModify && isInteractive && (
          <div className="space-y-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Describe what you want to change..."
              className="w-full rounded-xl bg-surface-0 border border-surface-3 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:ring-1 focus:ring-brand-500 focus:border-brand-500/50 outline-none resize-none"
              rows={3}
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleModifySubmit}
                disabled={!notes.trim()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-40 transition-all"
              >
                Re-analyze
              </button>
              <button
                onClick={() => { setShowModify(false); setNotes(""); }}
                className="px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 text-slate-300 text-xs font-medium transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {isInteractive && !showModify && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-surface-3/50">
          <button
            onClick={onApprove}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium shadow-sm transition-all"
          >
            <Play className="w-3 h-3" />
            Start Building
          </button>
          <button
            onClick={() => setShowModify(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 text-slate-300 text-xs font-medium transition-all"
          >
            <Pencil className="w-3 h-3" />
            Modify
          </button>
          <button
            onClick={onReject}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-red-500/10 text-slate-500 hover:text-red-400 text-xs font-medium transition-all ml-auto"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      )}

      {/* Building state */}
      {isBuilding && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-brand-500/20">
          <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin" />
          <span className="text-xs text-brand-400 font-medium">Agents are building your app...</span>
        </div>
      )}

      {/* Completed state */}
      {isDone && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-emerald-500/20">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs text-emerald-400 font-medium">Build plan executed</span>
        </div>
      )}
    </div>
  );
}
