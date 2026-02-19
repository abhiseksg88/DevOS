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

    setState((prev) => {
      const newState = { 
        ...prev, 
        pipelineEvents: [...prev.pipelineEvents, event] 
      };

      switch (event.kind) {
        case "agent_start":
          newState.pipelinePhase = mapAgentToPhase(event.agent || "");
          newState.streamedText = event.payload?.message || newState.streamedText;
          options.onPhaseChange?.(newState.pipelinePhase);
          break;

        case "info":
          if (event.payload?.hitl_required) {
            newState.pipelinePhase = "awaiting_approval";
            newState.currentPrd = event.payload.plan || null;
            newState.streamedText = "Plan ready for review.";
            options.onPhaseChange?.("awaiting_approval");
          } else if (event.payload?.message) {
            newState.streamedText = event.payload.message;
          }
          break;

        case "file_content": 
          const path = event.payload?.path;
          const content = event.payload?.content;
          if (path && content) {
            const existingIdx = newState.files.findIndex(f => f.path === path);
            if (existingIdx >= 0) {
              const newFiles = [...newState.files];
              newFiles[existingIdx] = { path, content };
              newState.files = newFiles;
            } else {
              newState.files = [...newState.files, { path, content }];
            }
            options.onFileGenerated?.(path, content);
          }
          break;

        case "stream_end":
          if (newState.pipelinePhase !== "awaiting_approval") {
            newState.isGenerating = false;
            newState.pipelinePhase = "done";
            options.onPhaseChange?.("done");
          }
          break;

        case "error":
          newState.error = event.error || "Unknown stream error";
          newState.isGenerating = false;
          newState.pipelinePhase = "error";
          options.onError?.(newState.error!);
          break;
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

    } catch (err: any) {
      const msg = err.message || "Failed to start build";
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

    } catch (err: any) {
      const msg = err.message || "Failed to approve build";
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
