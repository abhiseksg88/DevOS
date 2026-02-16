"use client";

import { useCallback, useRef, useState } from "react";
import type { FileNode } from "@/types";

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

interface GenerateState {
  isGenerating: boolean;
  streamedText: string;
  files: GeneratedFile[];
  error: string | null;
  pipelineEvents: PipelineEvent[];
}

/**
 * Parse files from Claude's response. Supports multiple formats:
 * 1. ===FILE: path=== ... ===END_FILE===
 * 2. ```tsx // path/to/file.tsx ... ```
 * 3. // File: path/to/file.tsx ... (next file or end)
 */
/** Sanitize file path to prevent directory traversal */
function sanitizePath(path: string): string | null {
  let clean = path.replace(/\0/g, "");
  clean = clean.replace(/\\/g, "/");
  clean = clean.replace(/^\/+/, "");
  if (clean.includes("..")) return null;
  if (clean.startsWith("~")) return null;
  if (clean.length === 0 || clean.length > 500) return null;
  return clean;
}

function parseFiles(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Format 1: ===FILE: path=== ... ===END_FILE===
  const delimiterRegex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = delimiterRegex.exec(text)) !== null) {
    const safePath = sanitizePath(match[1].trim());
    if (safePath) files.push({ path: safePath, content: match[2].trimEnd() });
  }
  if (files.length > 0) return files;

  // Format 2: ```language\n// filepath\n...``` or ```language:filepath\n...```
  const codeBlockRegex = /```(?:\w+)?\s*\n?\s*(?:\/\/\s*|\/\*\s*|#\s*)?(?:file:\s*|File:\s*|path:\s*)?([^\n*]+\.\w+)\s*\n([\s\S]*?)```/gi;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const path = match[1].trim().replace(/^\*\//, "").replace(/\s*\*\/$/, "");
    const safePath = sanitizePath(path);
    if (safePath && (safePath.includes("/") || safePath.includes("."))) {
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }
  if (files.length > 0) return files;

  // Format 3: Look for code blocks with file paths mentioned before them
  const sections = text.split(/(?=###?\s|(?:^|\n)(?:\*\*)?(?:File|`)[:\s])/);
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

  return files;
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

/** Stream code generation from /api/generate and return parsed files */
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
  // If there are review findings, prepend them to the prompt
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
          const parsed = parseFiles(fullText);
          if (parsed.length > lastParsedCount) {
            for (let i = lastParsedCount; i < parsed.length; i++) {
              onFileGenerated(parsed[i].path, parsed[i].content);
            }
            lastParsedCount = parsed.length;
          }
          onStreamUpdate(fullText, parsed);
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
    } catch { /* ignore */ }
  }

  const finalFiles = parseFiles(fullText);
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
    } else {
      errMsg = `Claude responded but output could not be parsed into files. Raw: ${fullText.length} chars.`;
    }
    return { files: [], error: errMsg };
  }

  return { files: finalFiles, error: null };
}

export function useGenerate() {
  const [state, setState] = useState<GenerateState>({
    isGenerating: false,
    streamedText: "",
    files: [],
    error: null,
    pipelineEvents: [],
  });
  const abortRef = useRef<AbortController | null>(null);

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

  const generate = useCallback(
    async (
      prompt: string,
      existingFiles: FileNode[],
      onFileGenerated: (path: string, content: string) => void,
      chatHistory?: Array<{ role: string; content: string }>
    ): Promise<GenerateResult> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        isGenerating: true,
        streamedText: "",
        files: [],
        error: null,
        pipelineEvents: [],
      });

      const flatFiles = flattenForContext(existingFiles);
      let prd: Record<string, unknown> | undefined;

      // ---------------------------------------------------------------
      // STAGE 1: Analyzer (DeepSeek) — generate PRD
      // ---------------------------------------------------------------
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
          body: JSON.stringify({ prompt, existingFiles: flatFiles }),
          signal: controller.signal,
        });

        if (analyzeResp.ok) {
          const analyzeData = await analyzeResp.json();
          prd = analyzeData.prd;
          const meta = analyzeData.meta;
          const summary = prd?.summary || "Analysis complete";
          const components = (prd?.new_components as Array<{ name: string }>) || [];
          const detail = components.length > 0
            ? `Components: ${components.map((c) => c.name).join(", ")}`
            : undefined;

          updatePipelineEvent(analyzeId, {
            status: "completed",
            message: String(summary),
            detail,
            meta,
          });
        } else {
          // Analyzer failed — continue without PRD (graceful degradation)
          updatePipelineEvent(analyzeId, {
            status: "skipped",
            message: "Analyzer unavailable, proceeding with direct generation",
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { files: [], error: null };
        }
        updatePipelineEvent(analyzeId, {
          status: "skipped",
          message: "Analyzer unavailable, proceeding with direct generation",
        });
      }

      // ---------------------------------------------------------------
      // STAGE 2: Coder (Claude Sonnet) — generate code
      // ---------------------------------------------------------------
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
          flatFiles,
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
        setState((prev) => ({ ...prev, isGenerating: false, error: errMsg }));
        return { files: [], error: errMsg };
      }

      if (result.error) {
        updatePipelineEvent(coderId, {
          status: "failed",
          message: `Code generation failed: ${result.error}`,
        });
        setState((prev) => ({ ...prev, isGenerating: false, error: result.error }));
        return result;
      }

      updatePipelineEvent(coderId, {
        status: "completed",
        message: `Generated ${result.files.length} file${result.files.length !== 1 ? "s" : ""}`,
        meta: { tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: Date.now() - coderStart },
      });

      // ---------------------------------------------------------------
      // STAGE 3: Reviewer (Claude Haiku) — review code
      // ---------------------------------------------------------------
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
            updatePipelineEvent(reviewId, {
              status: "completed",
              message: `Review passed (score: ${review?.score || "N/A"}/10)`,
              detail: findings.length > 0
                ? `${warnings.length} warning(s), ${findings.length - criticals.length - warnings.length} info`
                : "No issues found",
              meta,
            });
          } else {
            reviewFindings = criticals
              .map((f: { description: string; fix: string }) => `- ${f.description}. Fix: ${f.fix}`)
              .join("\n");
            updatePipelineEvent(reviewId, {
              status: "failed",
              message: `Review rejected (${criticals.length} critical issue${criticals.length !== 1 ? "s" : ""})`,
              detail: reviewFindings,
              meta,
            });
          }
        } else {
          // Reviewer failed — approve by default (don't block user)
          updatePipelineEvent(reviewId, {
            status: "skipped",
            message: "Reviewer unavailable, proceeding",
          });
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { files: [], error: null };
        }
        updatePipelineEvent(reviewId, {
          status: "skipped",
          message: "Reviewer unavailable, proceeding",
        });
      }

      // ---------------------------------------------------------------
      // STAGE 4: Fix (Claude Sonnet) — if review rejected, max 2 retries
      // ---------------------------------------------------------------
      if (!reviewApproved && reviewFindings) {
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
            prompt,
            flatFiles,
            chatHistory,
            prd,
            reviewFindings,
            onFileGenerated,
            (text, files) => {
              setState((prev) => ({ ...prev, streamedText: text, files }));
            },
            controller.signal,
          );

          if (fixResult.error) {
            updatePipelineEvent(fixId, {
              status: "failed",
              message: `Fix failed: ${fixResult.error}`,
            });
          } else {
            result = fixResult;
            updatePipelineEvent(fixId, {
              status: "completed",
              message: `Fixed ${fixResult.files.length} file${fixResult.files.length !== 1 ? "s" : ""}`,
            });
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            return { files: [], error: null };
          }
          updatePipelineEvent(fixId, {
            status: "failed",
            message: "Fix attempt failed",
          });
        }
      }

      // ---------------------------------------------------------------
      // DONE
      // ---------------------------------------------------------------
      setState((prev) => ({
        ...prev,
        isGenerating: false,
        files: result.files,
        streamedText: prev.streamedText,
      }));

      return result;
    },
    [addPipelineEvent, updatePipelineEvent]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, isGenerating: false }));
  }, []);

  return { ...state, generate, stop };
}
