"use client";

import { useState } from "react";
import type { ChatMessage } from "@/types";
import { cn } from "@/lib/utils";
import {
  Users,
  Database,
  Shield,
  Layout,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Play,
} from "lucide-react";

interface PlanReviewCardProps {
  proposal: NonNullable<ChatMessage["proposal"]>;
  criticalQuestion?: string;
  status: "pending" | "approved" | "building" | "completed";
  onApprove: () => void;
  onModify: (feedback: string) => void;
  disabled?: boolean;
}

export function PlanReviewCard({
  proposal,
  criticalQuestion,
  status,
  onApprove,
  onModify,
  disabled,
}: PlanReviewCardProps) {
  const [showModify, setShowModify] = useState(false);
  const [notes, setNotes] = useState("");

  const isInteractive = status === "pending" && !disabled;
  const isBuilding = status === "building";
  const isDone = status === "completed";

  const roles = proposal.roles ?? [];
  const schema = proposal.schema ?? {};
  const security = proposal.security;
  const screens = proposal.screens ?? [];

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
        "rounded-2xl border overflow-hidden animate-slide-up transition-all border-l-4",
        isDone
          ? "bg-emerald-500/5 border-emerald-500/20 border-l-emerald-500"
          : isBuilding
          ? "bg-brand-500/5 border-brand-500/30 border-l-brand-500 animate-pulse"
          : "bg-surface-2 border-surface-3 border-l-violet-500",
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
                : "bg-violet-500/20 text-violet-400",
            )}
          >
            {isDone ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : isBuilding ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Layout className="w-4 h-4" />
            )}
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">
              {isDone ? "Proposal Approved" : isBuilding ? "Building..." : proposal.app_name || "Architecture Proposal"}
            </span>
          </div>
        </div>
        <span className="px-2 py-0.5 rounded-full text-2xs font-medium uppercase tracking-wider bg-violet-500/10 text-violet-400">
          Proposal
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        {/* Three-column grid: Roles, Schema, Security */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Roles */}
          {roles.length > 0 && (
            <div className="bg-surface-0/50 border border-surface-3 rounded-xl p-3">
              <div className="flex items-center gap-1.5 text-2xs font-medium text-blue-400 uppercase tracking-wider mb-2">
                <Users className="w-3.5 h-3.5" /> User Roles
              </div>
              <div className="flex flex-wrap gap-1">
                {roles.map((role) => (
                  <span
                    key={role.name}
                    className="inline-block px-2 py-0.5 rounded-full text-2xs font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20"
                  >
                    {role.name}
                  </span>
                ))}
              </div>
              {roles.some((r) => r.can && r.can.length > 0) && (
                <div className="mt-2 space-y-1">
                  {roles.map((role) =>
                    role.can && role.can.length > 0 ? (
                      <div key={role.name} className="text-2xs text-slate-500">
                        <span className="text-slate-400">{role.name}:</span>{" "}
                        {role.can.join(", ")}
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </div>
          )}

          {/* Schema / Data Model */}
          {Object.keys(schema).length > 0 && (
            <div className="bg-surface-0/50 border border-surface-3 rounded-xl p-3">
              <div className="flex items-center gap-1.5 text-2xs font-medium text-emerald-400 uppercase tracking-wider mb-2">
                <Database className="w-3.5 h-3.5" /> Core Data
              </div>
              <div className="space-y-1.5">
                {Object.entries(schema).map(([name, def]) => (
                  <div key={name}>
                    <span className="text-xs font-medium text-slate-200">{name}</span>
                    {def.fields && def.fields.length > 0 && (
                      <div className="text-2xs text-slate-500 mt-0.5">
                        {def.fields.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Security */}
          {security && (
            <div className="bg-surface-0/50 border border-surface-3 rounded-xl p-3">
              <div className="flex items-center gap-1.5 text-2xs font-medium text-amber-400 uppercase tracking-wider mb-2">
                <Shield className="w-3.5 h-3.5" /> Security
              </div>
              <div className="space-y-1 text-2xs">
                <div className="flex items-center gap-1.5 text-slate-300">
                  <span className={security.auth_required ? "text-emerald-400" : "text-slate-600"}>
                    {security.auth_required ? "✓" : "✗"}
                  </span>
                  Authentication
                </div>
                <div className="flex items-center gap-1.5 text-slate-300">
                  <span className={security.rbac ? "text-emerald-400" : "text-slate-600"}>
                    {security.rbac ? "✓" : "✗"}
                  </span>
                  Role-Based Access
                </div>
                {security.data_isolation && (
                  <div className="text-slate-500">
                    Isolation: <span className="text-slate-400">{security.data_isolation}</span>
                  </div>
                )}
                {security.sensitive_fields && security.sensitive_fields.length > 0 && (
                  <div className="text-slate-500">
                    Sensitive: <span className="text-slate-400">{security.sensitive_fields.join(", ")}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Screens */}
        {screens.length > 0 && (
          <div>
            <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider mb-1.5">
              Screens
            </div>
            <div className="flex flex-wrap gap-1">
              {screens.map((screen) => (
                <span
                  key={screen}
                  className="inline-block px-2 py-0.5 rounded-md text-2xs font-mono text-slate-400 bg-surface-3/50 border border-surface-3"
                >
                  {screen}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Critical Question */}
        {criticalQuestion && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 flex gap-3 items-start">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-2xs font-medium text-amber-400 uppercase tracking-wider mb-1">
                Strategic Clarification
              </div>
              <p className="text-xs text-amber-200/80 leading-relaxed">
                {criticalQuestion}
              </p>
            </div>
          </div>
        )}

        {/* Modify Textarea */}
        {showModify && isInteractive && (
          <div className="space-y-2">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="E.g., 'Add a Manager role' or 'Use public access instead of RBAC'..."
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
                Submit Changes
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
            Approve &amp; Build
          </button>
          <button
            onClick={() => setShowModify(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 text-slate-300 text-xs font-medium transition-all"
          >
            <Pencil className="w-3 h-3" />
            Modify Plan
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
          <span className="text-xs text-emerald-400 font-medium">Proposal approved — build complete</span>
        </div>
      )}
    </div>
  );
}
