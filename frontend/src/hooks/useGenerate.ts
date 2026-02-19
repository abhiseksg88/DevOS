"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { builds, streamBuildEvents } from "@/lib/api";

// --- Types ---

interface GeneratedFile {
  path: string;
  content: string;
}

type PipelinePhase =
  | "idle"
  | "analyzing"
  | "awaiting_approval"
  | "scaffolding"
  | "building"
  | "reviewing"
  | "fixing"
  | "done"
  | "error";

export interface PipelineEvent {
  seq?: number;
  kind?: string;
  agent?: string;
  payload?: {
    message?: string;
    hitl_required?: boolean;
    plan?: Record<string, unknown>;
    path?: string;
    content?: string;
    [key: string]: unknown;
  };
  status?: string;
  error?: string;
}

interface GenerateState {
  buildId: string | null;
  isGenerating: boolean;
  pipelinePhase: PipelinePhase;
  streamedText: string;
  files: GeneratedFile[];
  currentPrd: Record<string, unknown> | null;
  error: string | null;
  pipelineEvents: PipelineEvent[];
}

export interface UseGenerateOptions {
  onFileGenerated?: (path: string, content: string) => void;
  onPhaseChange?: (phase: PipelinePhase) => void;
  onError?: (error: string) => void;
}

// --- Hook ---

export function useGenerate(options: UseGenerateOptions = {}) {
  const [state, setState] = useState<GenerateState>({
    buildId: null,
    isGenerating: false,
    pipelinePhase: "idle",
    streamedText: "",
    files: [],
    currentPrd: null,
    error: null,
    pipelineEvents: [],
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const eventSeqRef = useRef(0);
  // Keep a stable ref to options callbacks to avoid stale closures
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // --- Helpers ---

  const mapAgentToPhase = (agent: string): PipelinePhase => {
    switch (agent) {
      case "planner": return "analyzing";
      case "scaffolder": return "scaffolding";
      case "coder": return "building";
      case "reviewer": return "reviewing";
      case "fixer": return "fixing";
      default: return "building";
    }
  };

  // -----------------------------------------------------------------
  // handleBackendEvent — process each SSE event from the pipeline
  // Updates phase, stores events, extracts files, handles HITL gate
  // -----------------------------------------------------------------
  const handleBackendEvent = useCallback((event: PipelineEvent) => {
    // Track sequence for resuming streams
    if (typeof event.seq === "number") {
      eventSeqRef.current = event.seq;
    }

    // HITL checkpoint — plan is ready for user review
    if (event.payload?.hitl_required) {
      const plan = (event.payload?.plan as Record<string, unknown>) ?? null;
      setState(prev => ({
        ...prev,
        pipelinePhase: "awaiting_approval",
        currentPrd: plan,
        pipelineEvents: [...prev.pipelineEvents, event],
        streamedText: event.payload?.message as string || prev.streamedText,
      }));
      optionsRef.current.onPhaseChange?.("awaiting_approval");
      return;
    }

    // Update phase based on which agent is running
    let nextPhase: PipelinePhase | null = null;
    if (event.agent) {
      nextPhase = mapAgentToPhase(event.agent);
    }

    // File patch — extract generated file content
    const patchPath = event.payload?.path as string | undefined;
    const patchContent = event.payload?.content as string | undefined;
    if (patchPath && patchContent !== undefined) {
      optionsRef.current.onFileGenerated?.(patchPath, patchContent);
      setState(prev => ({
        ...prev,
        files: [...prev.files, { path: patchPath, content: patchContent }],
        pipelineEvents: [...prev.pipelineEvents, event],
        ...(nextPhase ? { pipelinePhase: nextPhase } : {}),
        ...(event.payload?.message ? { streamedText: event.payload.message as string } : {}),
      }));
      if (nextPhase) optionsRef.current.onPhaseChange?.(nextPhase);
      return;
    }

    // Error event
    if (event.kind === "error" || event.error) {
      const errMsg = (event.payload?.message as string) || event.error || "Build error occurred";
      setState(prev => ({
        ...prev,
        error: errMsg,
        pipelineEvents: [...prev.pipelineEvents, event],
      }));
      optionsRef.current.onError?.(errMsg);
      return;
    }

    // Generic event — update phase and streamed text
    setState(prev => ({
      ...prev,
      pipelineEvents: [...prev.pipelineEvents, event],
      ...(nextPhase ? { pipelinePhase: nextPhase } : {}),
      ...(event.payload?.message ? { streamedText: event.payload.message as string } : {}),
    }));
    if (nextPhase) optionsRef.current.onPhaseChange?.(nextPhase);
  }, []);

  // -----------------------------------------------------------------
  // connectStream — open SSE connection for a given build
  // Cancels any existing connection first so at most one is active.
  // -----------------------------------------------------------------
  const connectStream = useCallback((
    token: string,
    tenantId: string,
    projectId: string,
    buildId: string
  ) => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    streamBuildEvents(
      token,
      tenantId,
      projectId,
      buildId,
      eventSeqRef.current,
      handleBackendEvent,
      // onEnd — stream closed; build_status tells us the terminal state
      (buildStatus?: string) => {
        setState(prev => {
          // Intentional pause at HITL gate — don't transition
          if (prev.pipelinePhase === "awaiting_approval") return prev;
          // Already in a terminal state
          if (prev.pipelinePhase === "done" || prev.pipelinePhase === "error" || prev.pipelinePhase === "idle") return prev;

          if (buildStatus === "failed" || buildStatus === "cancelled") {
            const errMsg = `Build ${buildStatus}. Check your API keys and try again.`;
            optionsRef.current.onError?.(errMsg);
            return {
              ...prev,
              isGenerating: false,
              pipelinePhase: "error",
              error: prev.error || errMsg,
            };
          }
          optionsRef.current.onPhaseChange?.("done");
          return {
            ...prev,
            isGenerating: false,
            pipelinePhase: "done",
          };
        });
      },
      // onError
      (err: Error) => {
        console.error("[useGenerate] SSE error:", err);
        const errMsg = `Stream error: ${err.message}`;
        optionsRef.current.onError?.(errMsg);
        setState(prev => ({
          ...prev,
          error: errMsg,
          pipelinePhase: "error",
          isGenerating: false,
        }));
      }
    );
  }, [handleBackendEvent]);

  // --- Public API ---

  const startBuild = useCallback(async (
    token: string,
    tenantId: string,
    projectId: string,
    prompt: string
  ) => {
    try {
      setState(prev => ({
        ...prev,
        isGenerating: true,
        error: null,
        pipelinePhase: "analyzing",
        files: [],
        currentPrd: null,
        pipelineEvents: [],
        streamedText: "Initializing Neural Nexus..."
      }));
      eventSeqRef.current = 0;

      const build = await builds.create(token, tenantId, projectId, prompt);

      setState(prev => ({ ...prev, buildId: build.id }));
      connectStream(token, tenantId, projectId, build.id);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to start build";
      setState(prev => ({ ...prev, isGenerating: false, error: msg, pipelinePhase: "error" }));
      optionsRef.current.onError?.(msg);
    }
  }, [connectStream]);

  const approvePlan = useCallback(async (
    token: string,
    tenantId: string,
    projectId: string,
    buildId: string,
    modifiedPlan?: Record<string, unknown>
  ) => {
    try {
      setState(prev => ({
        ...prev,
        pipelinePhase: "scaffolding",
        streamedText: "Plan approved. Resuming build..."
      }));

      await builds.approve(token, tenantId, projectId, buildId, {
        action: "approve",
        modified_plan: modifiedPlan
      });

      connectStream(token, tenantId, projectId, buildId);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to approve build";
      setState(prev => ({ ...prev, error: msg }));
      optionsRef.current.onError?.(msg);
    }
  }, [connectStream]);

  const modifyBuild = useCallback(async (
    token: string,
    tenantId: string,
    projectId: string,
    buildId: string,
    newPlan: Record<string, unknown>
  ) => {
    return approvePlan(token, tenantId, projectId, buildId, newPlan);
  }, [approvePlan]);

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    setState(prev => ({
      ...prev,
      isGenerating: false,
      pipelinePhase: "idle",
      streamedText: "Build stopped by user."
    }));
  }, []);

  return {
    ...state,
    startBuild,
    approvePlan,
    modifyBuild,
    stop
  };
}
