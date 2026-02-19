"use client";

import { useCallback, useRef, useState } from "react";
import * as api from "@/lib/api";

interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  error: string | null;
}

// Pipeline event for the swarm UI
export interface PipelineEvent {
  id: string;
  agent: "analyzer" | "coder" | "reviewer" | "fixer";
  model: string;
  status: "running" | "completed" | "failed" | "skipped";
  message: string;
  detail?: string;
  meta?: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    latency_ms: number;
  };
}

type PipelinePhase = "idle" | "analyzing" | "awaiting_approval" | "building" | "reviewing" | "fixing" | "done" | "error";

interface GenerateState {
  isGenerating: boolean;
  isAnalyzing: boolean;
  streamedText: string;
  files: GeneratedFile[];
  error: string | null;
  pipelineEvents: PipelineEvent[];
  currentPrd: Record<string, unknown> | null;
  pipelinePhase: PipelinePhase;
  buildId: string | null;
}

// =====================================================================
// Auth context for backend API calls
// =====================================================================
export interface UseGenerateOptions {
  token: string | null;
  tenantId: string | null;
  projectId: string;
  /** Fetch a fresh Supabase JWT — called when token is stale/empty */
  getToken?: () => Promise<string>;
}

/**
 * Sanitize a file path from LLM output to prevent directory traversal
 * and overwriting sensitive files.
 */
function sanitizePath(path: string): string | null {
  let cleaned = path.trim();

  // Reject absolute paths
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return null;

  // Collapse and reject directory traversal
  if (cleaned.includes("..")) return null;

  // Strip leading slashes and dots
  cleaned = cleaned.replace(/^[./\\]+/, "");

  // Reject empty paths
  if (!cleaned) return null;

  // Reject sensitive file patterns
  const blocked = [".env", ".git", ".ssh", "node_modules", "credentials", ".secret"];
  const lowerPath = cleaned.toLowerCase();
  if (blocked.some((b) => lowerPath.startsWith(b) || lowerPath.includes("/" + b))) {
    return null;
  }

  return cleaned;
}

// =====================================================================
// Map backend agent names to frontend pipeline agent names
// =====================================================================
function mapBackendAgent(agent: string | null): PipelineEvent["agent"] {
  switch (agent) {
    case "planner":
    case "opus":
      return "analyzer";
    case "scaffolder":
    case "deepseek":
      return "coder";
    case "coder":
    case "sonnet":
      return "coder";
    case "reviewer":
      return "reviewer";
    case "fixer":
      return "fixer";
    default:
      return "coder";
  }
}

// Map backend agent names to model display strings
function mapBackendModel(agent: string | null): string {
  switch (agent) {
    case "planner":
    case "opus":
      return "claude-opus";
    case "scaffolder":
    case "deepseek":
      return "deepseek";
    case "coder":
    case "sonnet":
      return "claude-sonnet";
    case "reviewer":
      return "claude-sonnet";
    default:
      return agent || "unknown";
  }
}

// Map backend build status to pipeline phase
function mapBuildStatusToPhase(status: string): PipelinePhase {
  switch (status) {
    case "queued":
    case "planning":
      return "analyzing";
    case "awaiting_approval":
      return "awaiting_approval";
    case "scaffolding":
    case "coding":
      return "building";
    case "reviewing":
      return "reviewing";
    case "building":
    case "deploying":
      return "building";
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "idle";
    default:
      return "building";
  }
}


// =====================================================================
// Main hook — uses backend FastAPI pipeline as single control plane
// =====================================================================
export function useGenerate(options?: UseGenerateOptions) {
  const [state, setState] = useState<GenerateState>({
    isGenerating: false,
    isAnalyzing: false,
    streamedText: "",
    files: [],
    error: null,
    pipelineEvents: [],
    currentPrd: null,
    pipelinePhase: "idle",
    buildId: null,
  });

  const cancelSseRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Ref to always have latest onFileGenerated callback
  const onFileGeneratedRef = useRef<((path: string, content: string) => void) | null>(null);
  // Track last SSE seq for reconnection
  const lastSeqRef = useRef(0);

  const addPipelineEvent = useCallback((event: PipelineEvent) => {
    setState((prev) => ({
      ...prev,
      pipelineEvents: [...prev.pipelineEvents, event],
    }));
  }, []);

  const updatePipelineEvent = useCallback((id: string, updates: Partial<PipelineEvent>) => {
    setState((prev) => ({
      ...prev,
      pipelineEvents: prev.pipelineEvents.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    }));
  }, []);

  // -----------------------------------------------------------------
  // handleBackendEvent — Process SSE events from the backend pipeline
  // -----------------------------------------------------------------
  const handleBackendEvent = useCallback((event: Record<string, unknown>) => {
    const kind = event.kind as string;
    const payload = (event.payload || {}) as Record<string, unknown>;
    const agent = event.agent as string | null;
    const seq = event.seq as number | undefined;

    if (seq !== undefined) {
      lastSeqRef.current = seq;
    }

    switch (kind) {
      case "agent_start": {
        const eventId = crypto.randomUUID();
        const mappedAgent = mapBackendAgent(payload.agent as string || agent);
        addPipelineEvent({
          id: eventId,
          agent: mappedAgent,
          model: mapBackendModel(payload.agent as string || agent),
          status: "running",
          message: (payload.message as string) || `${mappedAgent} started`,
        });
        // Update phase based on which agent started
        const agentName = (payload.agent as string) || agent || "";
        if (agentName === "planner" || agentName === "opus") {
          setState((prev) => ({ ...prev, pipelinePhase: "analyzing", isAnalyzing: true }));
        } else if (agentName === "scaffolder" || agentName === "coder" || agentName === "deepseek" || agentName === "sonnet") {
          setState((prev) => ({ ...prev, pipelinePhase: "building", isGenerating: true, isAnalyzing: false }));
        } else if (agentName === "reviewer") {
          setState((prev) => ({ ...prev, pipelinePhase: "reviewing" }));
        }
        break;
      }

      case "agent_end": {
        // Find the last running event for this agent and mark completed
        setState((prev) => {
          const agentName = (payload.agent as string) || agent || "";
          const mappedAgent = mapBackendAgent(agentName);
          const idx = [...prev.pipelineEvents].reverse().findIndex(
            (e) => e.agent === mappedAgent && e.status === "running"
          );
          if (idx === -1) return prev;
          const realIdx = prev.pipelineEvents.length - 1 - idx;
          const updated = [...prev.pipelineEvents];
          updated[realIdx] = {
            ...updated[realIdx],
            status: "completed",
            message: (payload.message as string) || updated[realIdx].message,
          };
          return { ...prev, pipelineEvents: updated };
        });
        break;
      }

      case "info": {
        if (payload.hitl_required) {
          // HITL gate — planner has produced a plan, needs user approval
          const plan = payload.plan as Record<string, unknown> | undefined;
          setState((prev) => ({
            ...prev,
            isAnalyzing: false,
            currentPrd: plan || prev.currentPrd,
            pipelinePhase: "awaiting_approval",
          }));
        }
        break;
      }

      case "architectural_proposal": {
        // Rich proposal from the Lead Product Architect planner
        setState((prev) => ({
          ...prev,
          currentPrd: {
            ...(prev.currentPrd || {}),
            proposal: payload.proposal,
            critical_question: payload.critical_question,
          },
        }));
        break;
      }

      case "file_content": {
        // Backend emitted a generated file — update tree + preview
        const filePath = payload.path as string;
        const fileContent = payload.content as string;
        if (filePath && fileContent) {
          // Sanitize the path before passing through
          const safePath = sanitizePath(filePath);
          if (safePath) {
            onFileGeneratedRef.current?.(safePath, fileContent);
            setState((prev) => ({
              ...prev,
              files: [
                ...prev.files.filter(f => f.path !== safePath),
                { path: safePath, content: fileContent },
              ],
            }));
          }
        }
        break;
      }

      case "build_progress": {
        const status = payload.status as string | undefined;
        if (status) {
          const phase = mapBuildStatusToPhase(status);
          setState((prev) => ({ ...prev, pipelinePhase: phase }));
        }
        break;
      }

      case "error": {
        const errorMsg = (payload.message as string) || "Build error";
        setState((prev) => ({
          ...prev,
          error: errorMsg,
          pipelinePhase: "error",
          isGenerating: false,
          isAnalyzing: false,
        }));
        break;
      }

      case "warning": {
        // Log warnings but don't change state
        console.warn("[useGenerate] Backend warning:", payload.message);
        break;
      }

      default:
        // Unknown event kind — log for debugging
        console.log("[useGenerate] Unhandled backend event:", kind, payload);
    }
  }, [addPipelineEvent]);

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

      if (!authToken || !options?.tenantId) {
        setState((prev) => ({
          ...prev,
          error: "Not authenticated. Please sign in.",
          pipelinePhase: "error",
        }));
        return;
      }

      // Store callback ref
      if (onFileGenerated) {
        onFileGeneratedRef.current = onFileGenerated;
      }

      // Cancel any existing SSE/operations
      cancelSseRef.current?.();
      abortRef.current?.abort();
      lastSeqRef.current = 0;

      // Reset state for new build
      setState({
        isGenerating: false,
        isAnalyzing: true,
        streamedText: "",
        files: [],
        error: null,
        pipelineEvents: [],
        currentPrd: null,
        pipelinePhase: "analyzing",
        buildId: null,
      });

      try {
        // Step 1: Create the build via backend API
        const build = await api.builds.create(
          authToken,
          options.tenantId,
          options.projectId,
          prompt,
        );

        setState((prev) => ({ ...prev, buildId: build.id }));

        // Step 2: Start SSE event stream
        const cancel = api.streamBuildEvents(
          authToken,
          options.tenantId,
          options.projectId,
          build.id,
          0,
          // onEvent
          handleBackendEvent,
          // onEnd
          () => {
            setState((prev) => {
              // If we're still in a running state when stream ends, mark as done
              if (prev.pipelinePhase === "building" || prev.pipelinePhase === "reviewing" || prev.pipelinePhase === "fixing") {
                return {
                  ...prev,
                  isGenerating: false,
                  isAnalyzing: false,
                  pipelinePhase: "done",
                };
              }
              // If awaiting_approval, keep that state (stream paused, not ended)
              return prev;
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

        // Add initial pipeline event
        addPipelineEvent({
          id: crypto.randomUUID(),
          agent: "analyzer",
          model: "claude-opus",
          status: "running",
          message: "Starting build pipeline...",
        });

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Failed to create build";
        setState((prev) => ({
          ...prev,
          error: errMsg,
          pipelinePhase: "error",
          isGenerating: false,
          isAnalyzing: false,
        }));
      }
    },
    [options?.token, options?.tenantId, options?.projectId, handleBackendEvent, addPipelineEvent],
  );

  // -----------------------------------------------------------------
  // approveBuild() — Resume the pipeline after HITL approval
  // -----------------------------------------------------------------
  const approveBuild = useCallback(async () => {
    let authToken = options?.token || "";
    if (!authToken && options?.getToken) {
      try { authToken = await options.getToken(); } catch { /* fall through */ }
    }
    if (!authToken || !options?.tenantId || !state.buildId) {
      console.error("[useGenerate] Cannot approve: missing auth or buildId");
      return;
    }

    setState((prev) => ({
      ...prev,
      isGenerating: true,
      isAnalyzing: false,
      pipelinePhase: "building",
    }));

    try {
      await api.builds.approve(
        authToken,
        options.tenantId,
        options.projectId,
        state.buildId,
        { action: "approve" },
      );

      // Resume SSE from where we left off (the backend will emit new events)
      cancelSseRef.current?.();
      const cancel = api.streamBuildEvents(
        authToken,
        options.tenantId,
        options.projectId,
        state.buildId,
        lastSeqRef.current,
        handleBackendEvent,
        () => {
          setState((prev) => ({
            ...prev,
            isGenerating: false,
            isAnalyzing: false,
            pipelinePhase: prev.pipelinePhase === "error" ? "error" : "done",
          }));
        },
        (err: Error) => {
          console.error("[useGenerate] SSE error after approve:", err);
          setState((prev) => ({
            ...prev,
            error: `Stream error: ${err.message}`,
            pipelinePhase: "error",
            isGenerating: false,
          }));
        },
      );
      cancelSseRef.current = cancel;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to approve build";
      setState((prev) => ({
        ...prev,
        error: errMsg,
        pipelinePhase: "error",
        isGenerating: false,
      }));
    }
  }, [options?.token, options?.tenantId, options?.projectId, state.buildId, handleBackendEvent]);

  // -----------------------------------------------------------------
  // modifyBuild() — Re-plan with user feedback
  // -----------------------------------------------------------------
  const modifyBuild = useCallback(async (notes: string) => {
    let authToken = options?.token || "";
    if (!authToken && options?.getToken) {
      try { authToken = await options.getToken(); } catch { /* fall through */ }
    }
    if (!authToken || !options?.tenantId || !state.buildId) {
      console.error("[useGenerate] Cannot modify: missing auth or buildId");
      return;
    }

    setState((prev) => ({
      ...prev,
      isAnalyzing: true,
      pipelinePhase: "analyzing",
      currentPrd: null,
    }));

    try {
      const result = await api.builds.approve(
        authToken,
        options.tenantId,
        options.projectId,
        state.buildId,
        { action: "modify", notes },
      );

      // If the backend returned a new build_id (re-plan creates new build)
      const newBuildId = result.build_id || state.buildId;
      setState((prev) => ({ ...prev, buildId: newBuildId }));

      // Resume SSE on the (possibly new) build
      cancelSseRef.current?.();
      lastSeqRef.current = 0;
      const cancel = api.streamBuildEvents(
        authToken,
        options.tenantId,
        options.projectId,
        newBuildId,
        0,
        handleBackendEvent,
        () => {
          setState((prev) => {
            if (prev.pipelinePhase === "building" || prev.pipelinePhase === "reviewing") {
              return { ...prev, isGenerating: false, isAnalyzing: false, pipelinePhase: "done" };
            }
            return prev;
          });
        },
        (err: Error) => {
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

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to modify build";
      setState((prev) => ({
        ...prev,
        error: errMsg,
        pipelinePhase: "error",
        isAnalyzing: false,
      }));
    }
  }, [options?.token, options?.tenantId, options?.projectId, state.buildId, handleBackendEvent]);

  // -----------------------------------------------------------------
  // rejectBuild() — Cancel the build
  // -----------------------------------------------------------------
  const rejectBuild = useCallback(async () => {
    cancelSseRef.current?.();

    if (options?.token && options?.tenantId && state.buildId) {
      try {
        await api.builds.approve(
          options.token,
          options.tenantId,
          options.projectId,
          state.buildId,
          { action: "reject" },
        );
      } catch {
        // Best effort — build may already be cancelled
      }
    }

    setState((prev) => ({
      ...prev,
      isGenerating: false,
      isAnalyzing: false,
      pipelinePhase: "idle",
      buildId: null,
    }));
  }, [options?.token, options?.tenantId, options?.projectId, state.buildId]);

  // -----------------------------------------------------------------
  // stop() — Abort everything (SSE + any pending operations)
  // -----------------------------------------------------------------
  const stop = useCallback(() => {
    cancelSseRef.current?.();
    abortRef.current?.abort();

    // Best effort cancel on backend
    if (options?.token && options?.tenantId && state.buildId) {
      api.builds.cancel(
        options.token,
        options.tenantId,
        options.projectId,
        state.buildId,
      ).catch(() => {});
    }

    setState((prev) => ({
      ...prev,
      isGenerating: false,
      isAnalyzing: false,
      pipelinePhase: "idle",
    }));
  }, [options?.token, options?.tenantId, options?.projectId, state.buildId]);

  // -----------------------------------------------------------------
  // setOnFileGenerated — Update the callback ref
  // -----------------------------------------------------------------
  const setOnFileGenerated = useCallback((cb: (path: string, content: string) => void) => {
    onFileGeneratedRef.current = cb;
  }, []);

  return {
    ...state,
    startBuild,
    approveBuild,
    approvePlan: approveBuild,
    modifyBuild,
    rejectBuild,
    stop,
    setOnFileGenerated,
  };
}
