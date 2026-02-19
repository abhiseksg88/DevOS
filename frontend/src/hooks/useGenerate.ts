"use client";

import { useCallback, useRef, useState } from "react";
import type { FileNode } from "@/types";
import { createClient } from "@/lib/supabase/client";
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

export interface AnalyzeResult {
  prd: Record<string, unknown> | null;
  error: string | null;
  meta?: PipelineEvent["meta"];
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

// =====================================================================
// Utility functions (kept for auto-fix fallback path)
// =====================================================================

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

/**
 * Parsed file operation — either a full file create or a search/replace edit.
 * @deprecated Used only by legacy streamGenerate path
 */
interface FileOperation {
  type: "create" | "edit";
  path: string;
  content?: string;  // full content for "create"
  edits?: { search: string; replace: string }[];  // for "edit"
}

/**
 * Apply search/replace edits to existing file content.
 * @deprecated Used only by legacy streamGenerate path
 */
function applyEdits(original: string, edits: { search: string; replace: string }[]): string {
  let content = original;
  for (const edit of edits) {
    if (edit.search && content.includes(edit.search)) {
      content = content.replace(edit.search, edit.replace);
    }
  }
  return content;
}

/**
 * Pre-process LLM text to normalize common formatting variations.
 * @deprecated Used only by legacy streamGenerate path
 */
function preprocessLLMText(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/```[\w]*\s*\n(===(?:FILE|EDIT):)/g, "$1");
  cleaned = cleaned.replace(/(===END_(?:FILE|EDIT)===)\s*\n```/g, "$1");
  cleaned = cleaned.replace(/===FILE:\s*`([^`]+)`\s*===/g, "===FILE: $1===");
  cleaned = cleaned.replace(/===EDIT:\s*`([^`]+)`\s*===/g, "===EDIT: $1===");
  cleaned = cleaned.replace(/===FILE:\s*\*\*([^*]+)\*\*\s*===/g, "===FILE: $1===");
  return cleaned;
}

/**
 * Parse files from Claude's response.
 * @deprecated Used only by legacy streamGenerate/auto-fix path
 */
function parseFiles(text: string, allowTruncated = false, existingFiles?: { path: string; content: string }[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const cleanText = preprocessLLMText(text);

  // Format 1: ===FILE: path=== ... ===END_FILE===
  const delimiterRegex = /===FILE:\s*(.+?)===\s*\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = delimiterRegex.exec(cleanText)) !== null) {
    const safePath = sanitizePath(match[1].trim());
    if (safePath) {
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }

  // Format 1.5: ===EDIT: path=== with SEARCH/REPLACE blocks
  const editRegex = /===EDIT:\s*(.+?)===\r?\n([\s\S]*?)===END_EDIT===/g;
  while ((match = editRegex.exec(cleanText)) !== null) {
    const editPath = match[1]?.trim();
    const safePath = editPath ? sanitizePath(editPath) : null;
    if (!safePath) continue;
    if (files.some(f => f.path === safePath)) continue;

    const editBody = match[2];
    const edits: { search: string; replace: string }[] = [];
    const srRegex = /<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)(?=<<<SEARCH|$)/g;
    let srMatch;
    while ((srMatch = srRegex.exec(editBody)) !== null) {
      edits.push({
        search: srMatch[1].replace(/\n$/, ""),
        replace: srMatch[2].replace(/\n$/, ""),
      });
    }

    if (edits.length > 0 && existingFiles) {
      const existing = existingFiles.find(f => f.path === safePath);
      if (existing) {
        const result = applyEdits(existing.content, edits);
        files.push({ path: safePath, content: result });
      }
    }
  }

  // Format 1b: Truncated file recovery
  if (allowTruncated) {
    const lastFileIdx = cleanText.lastIndexOf("===FILE:");
    if (lastFileIdx !== -1) {
      const tail = cleanText.substring(lastFileIdx);
      if (!tail.includes("===END_FILE===")) {
        const headerMatch = tail.match(/^===FILE:\s*(.+?)===\n([\s\S]+)$/);
        if (headerMatch) {
          const safePath = sanitizePath(headerMatch[1].trim());
          if (safePath && !files.some(f => f.path === safePath)) {
            const content = headerMatch[2].trimEnd();
            if (content.length >= 100) {
              files.push({ path: safePath, content });
            }
          }
        }
      }
    }
  }

  if (files.length > 0) return files;

  // Format 3: ```language\n// filepath\n...```
  const codeBlockRegex = /```(?:\w+)?\s*\n?\s*(?:\/\/\s*|\/\*\s*|#\s*)?(?:file:\s*|File:\s*|path:\s*)?([^\n*]+\.\w+)\s*\n([\s\S]*?)```/gi;
  while ((match = codeBlockRegex.exec(cleanText)) !== null) {
    const path = match[1].trim().replace(/^\*\//, "").replace(/\s*\*\/$/, "");
    const safePath = sanitizePath(path);
    if (safePath && (safePath.includes("/") || safePath.includes("."))) {
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }
  if (files.length > 0) return files;

  // Format 4: Code blocks with file paths mentioned before them
  const sections = cleanText.split(/(?=###?\s|(?:^|\n)(?:\*\*)?(?:File|`)[:\s])/);
  for (const section of sections) {
    const pathMatch = section.match(
      /(?:###?\s*|(?:\*\*)?(?:File|`)[:\s]*\s*)([`"]?)([a-zA-Z][\w./\-]+\.\w{1,10})\1/
    );
    if (!pathMatch) continue;
    const codeMatch = section.match(/```\w*\n([\s\S]*?)```/);
    if (!codeMatch) continue;
    const safePath = sanitizePath(pathMatch[2].trim());
    if (safePath) files.push({ path: safePath, content: codeMatch[1].trimEnd() });
  }
  if (files.length > 0) return files;

  // Format 5 (LAST RESORT): Extract largest code block as page.tsx
  const allCodeBlocks: { content: string; lang: string }[] = [];
  const anyCodeBlock = /```(\w*)\n([\s\S]*?)```/g;
  while ((match = anyCodeBlock.exec(cleanText)) !== null) {
    const content = match[2].trimEnd();
    if (content.length > 200) {
      allCodeBlocks.push({ content, lang: match[1] || "" });
    }
  }
  if (allCodeBlocks.length > 0) {
    allCodeBlocks.sort((a, b) => b.content.length - a.content.length);
    const biggest = allCodeBlocks[0];
    const looksLikeReact = /(?:export\s+default|function\s+\w+|return\s*\()/.test(biggest.content);
    if (looksLikeReact) {
      files.push({ path: "src/app/page.tsx", content: biggest.content });
      for (let i = 1; i < allCodeBlocks.length && i < 5; i++) {
        const block = allCodeBlocks[i];
        const exportMatch = block.content.match(/export\s+default\s+function\s+(\w+)/);
        if (exportMatch) {
          files.push({ path: `src/components/${exportMatch[1]}.tsx`, content: block.content });
        }
      }
    }
  }

  return files;
}

/**
 * Fire-and-forget: record generation telemetry to Neural Nexus tables.
 * @deprecated Backend pipeline records to Nexus automatically
 */
function recordToNexus(
  prompt: string,
  files: GeneratedFile[],
  pipelineEvents: PipelineEvent[],
  prd?: Record<string, unknown>,
) {
  (async () => {
    try {
      const pathParts = window.location.pathname.split("/");
      const projIdx = pathParts.indexOf("project");
      const projectId = projIdx >= 0 ? pathParts[projIdx + 1] : null;
      if (!projectId) return;

      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      await fetch("/api/nexus/record", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ projectId, prompt, files, pipelineEvents, prd }),
      });
    } catch {
      // Silently ignore — Nexus recording is best-effort
    }
  })();
}

/** Flatten file tree to get existing file contents for context */
function flattenForContext(nodes: FileNode[]): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.content) {
      result.push({ path: node.path, content: node.content });
    }
    if (node.children) {
      result.push(...flattenForContext(node.children));
    }
  }
  return result;
}

/**
 * Stream code generation from /api/generate and return parsed files.
 * @deprecated Used only by legacy auto-fix path. Primary pipeline uses backend SSE.
 */
async function streamGenerate(
  prompt: string,
  existingFiles: { path: string; content: string }[],
  chatHistory: Array<{ role: string; content: string }> | undefined,
  prd: Record<string, unknown> | undefined,
  reviewFindings: string | undefined,
  onFileGenerated: (path: string, content: string) => void,
  onStreamUpdate: (text: string, files: GeneratedFile[]) => void,
  signal: AbortSignal,
): Promise<GenerateResult> {
  const effectivePrompt = reviewFindings
    ? `${prompt}\n\nThe reviewer found these issues with the previous code. Fix them:\n${reviewFindings}`
    : prompt;

  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: effectivePrompt,
      existingFiles,
      messages: chatHistory,
      prd,
    }),
    signal,
  });

  if (!response.ok) {
    let errMsg = `Generation failed (HTTP ${response.status})`;
    try {
      const err = await response.json();
      errMsg = err.error || errMsg;
    } catch {
      try {
        const text = await response.text();
        if (text.includes("<!DOCTYPE") || text.includes("<html")) {
          errMsg = `Server returned an HTML error page (HTTP ${response.status}). The API route may not be deployed correctly.`;
        }
      } catch { /* ignore */ }
    }
    return { files: [], error: errMsg };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") && !contentType.includes("text/plain")) {
    const body = await response.text();
    let errMsg = `Unexpected response type: ${contentType || "unknown"}`;
    if (body.includes("<!DOCTYPE") || body.includes("<html")) {
      errMsg = "Server returned an HTML page instead of a code generation stream.";
    }
    return { files: [], error: errMsg };
  }

  const reader = response.body?.getReader();
  if (!reader) return { files: [], error: "No response stream" };

  const decoder = new TextDecoder();
  let fullText = "";
  let rawBytes = 0;
  let lastParsedCount = 0;
  let buffer = "";
  let stopReason = "end_turn";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    rawBytes += value?.byteLength ?? 0;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;
      try {
        const event = JSON.parse(jsonStr);
        if (event.type === "text") {
          fullText += event.content;
          const parsed = parseFiles(fullText, false, existingFiles);
          if (parsed.length > lastParsedCount) {
            for (let i = lastParsedCount; i < parsed.length; i++) {
              onFileGenerated(parsed[i].path, parsed[i].content);
            }
            lastParsedCount = parsed.length;
          }
          onStreamUpdate(fullText, parsed);
        } else if (event.type === "stop") {
          stopReason = event.stop_reason || "end_turn";
        } else if (event.type === "error") {
          return { files: [], error: event.error || "Generation error" };
        }
      } catch { /* skip malformed JSON */ }
    }
  }

  // Process remaining buffer
  if (buffer.startsWith("data: ")) {
    try {
      const event = JSON.parse(buffer.slice(6).trim());
      if (event.type === "text") fullText += event.content;
      if (event.type === "stop") stopReason = event.stop_reason || "end_turn";
    } catch { /* ignore */ }
  }

  const wasTruncated = stopReason === "max_tokens";

  // AUTO-CLOSE: If the last ===FILE: block has no ===END_FILE===, close it
  let textForParsing = fullText;
  const lastFileStart = fullText.lastIndexOf("===FILE:");
  if (lastFileStart !== -1) {
    const textAfterLastFile = fullText.substring(lastFileStart);
    if (!textAfterLastFile.includes("===END_FILE===")) {
      textForParsing = fullText.trimEnd() + "\n===END_FILE===";
    }
  }

  let finalFiles = parseFiles(textForParsing, false, existingFiles);

  if (finalFiles.length === 0) {
    const withRecovery = parseFiles(fullText, true, existingFiles);
    for (const rf of withRecovery) {
      if (!finalFiles.some(f => f.path === rf.path)) {
        finalFiles.push(rf);
      }
    }
  }

  // "Vanishing Keystone" safety net
  const hasPageFile = finalFiles.some(f =>
    f.path.includes("page.tsx") || f.path.includes("page.jsx") ||
    f.path.includes("App.tsx") || f.path.includes("App.jsx")
  );
  const componentFiles = finalFiles.filter(f =>
    f.path.includes("/components/") &&
    (f.path.endsWith(".tsx") || f.path.endsWith(".jsx"))
  );

  if (!hasPageFile && componentFiles.length > 0) {
    const imports: string[] = [];
    const renders: string[] = [];
    for (const cf of componentFiles) {
      const name = cf.path.split("/").pop()?.replace(/\.(tsx|jsx)$/, "") ?? "Component";
      const importPath = "@/" + cf.path.replace(/^src\//, "").replace(/\.(tsx|jsx)$/, "");
      imports.push(`import ${name} from "${importPath}";`);
      renders.push(`        <${name} />`);
    }

    const scaffoldPage = `import { useState } from "react";
${imports.join("\n")}

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-bold text-slate-900 mb-8">App</h1>
${renders.join("\n")}
      </div>
    </div>
  );
}
`;
    finalFiles.push({ path: "src/app/page.tsx", content: scaffoldPage });
    onFileGenerated("src/app/page.tsx", scaffoldPage);
  }

  if (finalFiles.length > lastParsedCount) {
    for (let i = lastParsedCount; i < finalFiles.length; i++) {
      onFileGenerated(finalFiles[i].path, finalFiles[i].content);
    }
  }

  if (finalFiles.length === 0) {
    let errMsg: string;
    if (rawBytes === 0) {
      errMsg = "The API returned an empty response. Check ANTHROPIC_API_KEY in Netlify environment variables.";
    } else if (fullText.length === 0) {
      errMsg = `Received ${rawBytes} bytes but no text content extracted.`;
    } else if (wasTruncated) {
      errMsg = `Response was truncated (hit token limit). The app may be too complex for a single generation.`;
    } else {
      const hasFileDelimiter = fullText.includes("===FILE:");
      const hasEndFile = fullText.includes("===END_FILE===");
      const autoCloseUsed = textForParsing !== fullText;
      errMsg = `Could not parse files (${fullText.length} chars). ${hasFileDelimiter ? 'Has ===FILE: delimiter.' : 'No ===FILE: found.'} ${hasEndFile ? '' : 'No ===END_FILE=== found.'} ${autoCloseUsed ? 'Auto-close was attempted.' : ''}`.trim();
    }
    return { files: [], error: errMsg };
  }

  return { files: finalFiles, error: null };
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

  // -----------------------------------------------------------------
  // Legacy methods — @deprecated, kept for auto-fix path compatibility
  // -----------------------------------------------------------------

  /** @deprecated Use startBuild() instead. Kept for auto-fix backward compat. */
  const analyze = useCallback(
    async (
      prompt: string,
      existingFiles: FileNode[],
      chatHistory?: Array<{ role: string; content: string }>
    ): Promise<AnalyzeResult> => {
      void chatHistory;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({
        ...prev,
        isAnalyzing: true,
        error: null,
        pipelineEvents: [],
        currentPrd: null,
        pipelinePhase: "analyzing",
      }));

      const flatFiles = flattenForContext(existingFiles);
      const contextFiles = flatFiles.filter(
        (f) => !f.content.includes("// Your generated code will appear here")
      );

      const analyzeId = crypto.randomUUID();
      addPipelineEvent({
        id: analyzeId,
        agent: "analyzer",
        model: "deepseek",
        status: "running",
        message: "Analyzing requirements...",
      });

      try {
        const analyzeResp = await fetch("/api/swarm/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, existingFiles: contextFiles }),
          signal: controller.signal,
        });

        if (analyzeResp.ok) {
          const analyzeData = await analyzeResp.json();
          const prd = analyzeData.prd;
          const meta = analyzeData.meta;
          const summary = prd?.summary || "Analysis complete";
          const components = (prd?.new_components as Array<{ name: string }>) || [];
          const detail = components.length > 0
            ? `Components: ${components.map((c: { name: string }) => c.name).join(", ")}`
            : undefined;

          updatePipelineEvent(analyzeId, {
            status: "completed",
            message: String(summary),
            detail,
            meta,
          });

          setState((prev) => ({
            ...prev,
            isAnalyzing: false,
            currentPrd: prd,
            pipelinePhase: "awaiting_approval",
          }));

          return { prd, error: null, meta };
        } else {
          updatePipelineEvent(analyzeId, {
            status: "skipped",
            message: "Analyzer unavailable",
          });
          setState((prev) => ({
            ...prev,
            isAnalyzing: false,
            pipelinePhase: "error",
          }));
          return { prd: null, error: "Analyzer unavailable" };
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setState((prev) => ({ ...prev, isAnalyzing: false, pipelinePhase: "idle" }));
          return { prd: null, error: null };
        }
        updatePipelineEvent(analyzeId, {
          status: "skipped",
          message: "Analyzer unavailable",
        });
        setState((prev) => ({
          ...prev,
          isAnalyzing: false,
          pipelinePhase: "error",
        }));
        return { prd: null, error: "Analyzer failed" };
      }
    },
    [addPipelineEvent, updatePipelineEvent],
  );

  /** @deprecated Use approveBuild() instead. Kept for auto-fix backward compat. */
  const build = useCallback(
    async (
      prompt: string,
      existingFiles: FileNode[],
      onFileGenerated: (path: string, content: string) => void,
      chatHistory?: Array<{ role: string; content: string }>,
      prd?: Record<string, unknown>,
    ): Promise<GenerateResult> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const localEvents: PipelineEvent[] = [];

      setState((prev) => ({
        ...prev,
        isGenerating: true,
        streamedText: "",
        files: [],
        error: null,
        pipelinePhase: "building",
      }));

      const flatFiles = flattenForContext(existingFiles);
      const contextFiles = flatFiles.filter(
        (f) => !f.content.includes("// Your generated code will appear here")
      );

      const coderId = crypto.randomUUID();
      addPipelineEvent({
        id: coderId,
        agent: "coder",
        model: "claude-sonnet",
        status: "running",
        message: "Generating code...",
      });

      const coderStart = Date.now();
      let result: GenerateResult;

      try {
        result = await streamGenerate(
          prompt,
          contextFiles,
          chatHistory,
          prd,
          undefined,
          onFileGenerated,
          (text, files) => {
            setState((prev) => ({ ...prev, streamedText: text, files }));
          },
          controller.signal,
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { files: [], error: null };
        }
        const errMsg = err instanceof Error ? err.message : "Generation failed";
        setState((prev) => ({ ...prev, isGenerating: false, error: errMsg, pipelinePhase: "error" }));
        return { files: [], error: errMsg };
      }

      if (result.error) {
        updatePipelineEvent(coderId, {
          status: "failed",
          message: `Code generation failed: ${result.error}`,
        });
        setState((prev) => ({ ...prev, isGenerating: false, error: result.error, pipelinePhase: "error" }));
        return result;
      }

      const coderMeta = { tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: Date.now() - coderStart };
      updatePipelineEvent(coderId, {
        status: "completed",
        message: `Generated ${result.files.length} file${result.files.length !== 1 ? "s" : ""}`,
        meta: coderMeta,
      });
      localEvents.push({ id: coderId, agent: "coder", model: "claude-sonnet", status: "completed", message: `Generated ${result.files.length} files`, meta: coderMeta });

      // Reviewer
      setState((prev) => ({ ...prev, pipelinePhase: "reviewing" }));
      const reviewId = crypto.randomUUID();
      addPipelineEvent({
        id: reviewId,
        agent: "reviewer",
        model: "claude-haiku",
        status: "running",
        message: "Reviewing code quality & security...",
      });

      let reviewApproved = true;
      let reviewFindings = "";

      try {
        const reviewResp = await fetch("/api/swarm/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prd, files: result.files }),
          signal: controller.signal,
        });

        if (reviewResp.ok) {
          const reviewData = await reviewResp.json();
          const review = reviewData.review;
          const meta = reviewData.meta;
          reviewApproved = review?.approved !== false;

          const findings = review?.findings || [];
          const criticals = findings.filter((f: { severity: string }) => f.severity === "critical");
          const warnings = findings.filter((f: { severity: string }) => f.severity === "warning");

          if (reviewApproved) {
            const reviewMsg = `Review passed (score: ${review?.score || "N/A"}/10)`;
            updatePipelineEvent(reviewId, {
              status: "completed",
              message: reviewMsg,
              detail: findings.length > 0
                ? `${warnings.length} warning(s), ${findings.length - criticals.length - warnings.length} info`
                : "No issues found",
              meta,
            });
            localEvents.push({ id: reviewId, agent: "reviewer", model: "claude-haiku", status: "completed", message: reviewMsg, meta });
          } else {
            reviewFindings = criticals
              .map((f: { description: string; fix: string }) => `- ${f.description}. Fix: ${f.fix}`)
              .join("\n");
            const rejectMsg = `Review rejected (${criticals.length} critical issue${criticals.length !== 1 ? "s" : ""})`;
            updatePipelineEvent(reviewId, {
              status: "failed",
              message: rejectMsg,
              detail: reviewFindings,
              meta,
            });
            localEvents.push({ id: reviewId, agent: "reviewer", model: "claude-haiku", status: "failed", message: rejectMsg, meta });
          }
        } else {
          updatePipelineEvent(reviewId, { status: "skipped", message: "Reviewer unavailable, proceeding" });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { files: [], error: null };
        }
        updatePipelineEvent(reviewId, { status: "skipped", message: "Reviewer unavailable, proceeding" });
      }

      // Fix stage
      if (!reviewApproved && reviewFindings) {
        setState((prev) => ({ ...prev, pipelinePhase: "fixing" }));
        const fixId = crypto.randomUUID();
        addPipelineEvent({
          id: fixId,
          agent: "fixer",
          model: "claude-sonnet",
          status: "running",
          message: "Fixing issues found by reviewer...",
        });

        try {
          const fixResult = await streamGenerate(
            prompt, contextFiles, chatHistory, prd, reviewFindings,
            onFileGenerated,
            (text, files) => { setState((prev) => ({ ...prev, streamedText: text, files })); },
            controller.signal,
          );
          if (fixResult.error) {
            updatePipelineEvent(fixId, { status: "failed", message: `Fix failed: ${fixResult.error}` });
          } else {
            result = fixResult;
            updatePipelineEvent(fixId, { status: "completed", message: `Fixed ${fixResult.files.length} file${fixResult.files.length !== 1 ? "s" : ""}` });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return { files: [], error: null };
          updatePipelineEvent(fixId, { status: "failed", message: "Fix attempt failed" });
        }
      }

      if (result.files.length > 0) {
        recordToNexus(prompt, result.files, localEvents, prd);
      }

      setState((prev) => ({
        ...prev,
        isGenerating: false,
        files: result.files,
        streamedText: prev.streamedText,
        pipelinePhase: "done",
      }));

      return result;
    },
    [addPipelineEvent, updatePipelineEvent],
  );

  /** @deprecated Use startBuild() + approveBuild() instead. */
  const generate = useCallback(
    async (
      prompt: string,
      existingFiles: FileNode[],
      onFileGenerated: (path: string, content: string) => void,
      chatHistory?: Array<{ role: string; content: string }>
    ): Promise<GenerateResult> => {
      setState({
        isGenerating: true,
        isAnalyzing: true,
        streamedText: "",
        files: [],
        error: null,
        pipelineEvents: [],
        currentPrd: null,
        pipelinePhase: "analyzing",
        buildId: null,
      });

      const analyzeResult = await analyze(prompt, existingFiles, chatHistory);
      const prd = analyzeResult.prd ?? undefined;
      const buildResult = await build(prompt, existingFiles, onFileGenerated, chatHistory, prd);
      return buildResult;
    },
    [analyze, build],
  );

  return {
    ...state,
    // Primary API — backend pipeline
    startBuild,
    approveBuild,
    modifyBuild,
    rejectBuild,
    stop,
    setOnFileGenerated,
    // Legacy API — @deprecated, kept for backward compat
    analyze,
    build,
    generate,
  };
}
