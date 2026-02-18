"use client";

import { useMemo, useRef, useEffect } from "react";
import type { PipelineEvent } from "@/hooks/useGenerate";

// ---------------------------------------------------------------------------
// Workspace mode system — auto-derives the current mode from build state.
// No manual toggle. The system decides what to show.
// ---------------------------------------------------------------------------

export type WorkspaceMode =
  | "idle"
  | "plan"
  | "build"
  | "review"
  | "deploy"
  | "preview";

export type WorkspaceTab =
  | "code"
  | "preview"
  | "console"
  | "infra"
  | "history"
  | "design";

interface GeneratorState {
  isAnalyzing: boolean;
  isGenerating: boolean;
  pipelineEvents: PipelineEvent[];
  files: Array<{ path: string; content: string }>;
}

interface AutoFixState {
  isFixing: boolean;
}

interface ModeResult {
  mode: WorkspaceMode;
  /** Suggested tab — null means keep current */
  autoTab: WorkspaceTab | null;
  /** Short status label for the command bar badge */
  statusLabel: string;
  /** Badge color class */
  statusColor: string;
}

export function useWorkspaceMode(
  generator: GeneratorState,
  autoFix: AutoFixState,
  deploymentStatus?: string,
  hasPreviewContent?: boolean,
): ModeResult {
  const prevModeRef = useRef<WorkspaceMode>("idle");

  const result = useMemo<ModeResult>(() => {
    // Deploying takes priority
    if (deploymentStatus === "deploying") {
      return {
        mode: "deploy",
        autoTab: "preview",
        statusLabel: "Deploying",
        statusColor: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
      };
    }

    // Check pipeline stages for reviewer
    const activeEvent = [...generator.pipelineEvents]
      .reverse()
      .find((e) => e.status === "running");

    if (activeEvent?.agent === "reviewer") {
      return {
        mode: "review",
        autoTab: "console",
        statusLabel: "Reviewing",
        statusColor: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
      };
    }

    // Analyzing → plan mode
    if (generator.isAnalyzing) {
      return {
        mode: "plan",
        autoTab: null, // plan card floats above command bar
        statusLabel: "Planning",
        statusColor: "bg-amber-500/10 border-amber-500/20 text-amber-400",
      };
    }

    // Generating code → build mode
    if (generator.isGenerating) {
      return {
        mode: "build",
        autoTab: "console",
        statusLabel: "Building",
        statusColor: "bg-blue-500/10 border-blue-500/20 text-blue-400",
      };
    }

    // Auto-fixing → stay in build mode
    if (autoFix.isFixing) {
      return {
        mode: "build",
        autoTab: "preview",
        statusLabel: "Refining",
        statusColor: "bg-violet-500/10 border-violet-500/20 text-violet-400",
      };
    }

    // Has preview content → preview mode
    if (hasPreviewContent) {
      return {
        mode: "preview",
        autoTab: null, // don't force tab switch
        statusLabel: "Ready",
        statusColor: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
      };
    }

    // Default idle
    return {
      mode: "idle",
      autoTab: null,
      statusLabel: "",
      statusColor: "",
    };
  }, [
    generator.isAnalyzing,
    generator.isGenerating,
    generator.pipelineEvents,
    autoFix.isFixing,
    deploymentStatus,
    hasPreviewContent,
  ]);

  // Track transitions
  useEffect(() => {
    prevModeRef.current = result.mode;
  }, [result.mode]);

  return result;
}
