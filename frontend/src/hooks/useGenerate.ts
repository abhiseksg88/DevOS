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

  const handleStreamEvent = useCallback((event: PipelineEvent) => {
    if (typeof event.seq === "number") {
      eventSeqRef.current = event.seq;
    }
  }, [addPipelineEvent]);

  // -----------------------------------------------------------------
  // openSseStream — (Re-)open the SSE stream for a given build.
  // Cancels any existing stream first so there is always at most one
  // active connection. Used by startBuild, approveBuild, modifyBuild.
  // Step 3 compliance: approveBuild explicitly calls this to
  // re-establish the stream after the backend pauses at the HITL gate.
  // -----------------------------------------------------------------
  const openSseStream = useCallback(
    (authToken: string, buildId: string, fromSeq: number) => {
      cancelSseRef.current?.();
      const cancel = api.streamBuildEvents(
        authToken,
        options!.tenantId!,
        options!.projectId,
        buildId,
        fromSeq,
        handleBackendEvent,
        // onEnd — stream closed; build_status tells us the terminal state
        (buildStatus?: string) => {
          setState((prev) => {
            // Already in a terminal or paused state — nothing to do
            if (
              prev.pipelinePhase === "done" ||
              prev.pipelinePhase === "error" ||
              prev.pipelinePhase === "idle" ||
              prev.pipelinePhase === "awaiting_approval" // intentional pause
            ) {
              return prev;
            }
            // Build failed or was cancelled → show error
            if (buildStatus === "failed" || buildStatus === "cancelled") {
              return {
                ...prev,
                isGenerating: false,
                isAnalyzing: false,
                pipelinePhase: "error",
                error: prev.error || `Build ${buildStatus}. Check your API keys and try again.`,
              };
            }
            // Any active phase (analyzing, building, reviewing, fixing) → done
            return {
              ...prev,
              isGenerating: false,
              isAnalyzing: false,
              pipelinePhase: "done",
            };
          });
        },
        // onError
        (err: Error) => {
          console.error("[useGenerate] SSE error:", err);
          setState((prev) => ({
            ...prev,
            error: `Stream error: ${err.message}`,
            pipelinePhase: "error",
            isGenerating: false,
            isAnalyzing: false,
          }));
        },
      );
      cancelSseRef.current = cancel;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options?.tenantId, options?.projectId, handleBackendEvent],
  );

  // -----------------------------------------------------------------
  // startBuild() — Create a build and start SSE streaming
  // -----------------------------------------------------------------
  const startBuild = useCallback(
    async (prompt: string, onFileGenerated?: (path: string, content: string) => void) => {
      // Resolve auth token — use passed token, or fetch fresh one via getToken()
      let authToken = options?.token || "";
      if (!authToken && options?.getToken) {
        try {
          authToken = await options.getToken();
        } catch {
          // getToken failed — fall through to the guard below
        }
      }

      return newState;
    });
  }, [options]);

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
      handleStreamEvent,
      () => { /* onEnd */ },
      (err) => {
        console.error("Stream connection lost:", err);
        setState(prev => ({ 
          ...prev, 
          error: `Connection lost: ${err.message}`, 
          isGenerating: false, 
          pipelinePhase: "error"
        }));
      }
    );
  }, [handleStreamEvent]);

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
      options.onError?.(msg);
    }
  }, [connectStream, options]);

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
      options.onError?.(msg);
    }
  }, [connectStream, options]);

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
