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
 */
interface FileOperation {
  type: "create" | "edit";
  path: string;
  content?: string;  // full content for "create"
  edits?: { search: string; replace: string }[];  // for "edit"
}

/**
 * Apply search/replace edits to existing file content.
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
 * - Strips markdown code blocks wrapping ===FILE=== delimiters
 * - Removes backticks around file paths in delimiters
 * - Normalizes whitespace in delimiters
 */
function preprocessLLMText(text: string): string {
  let cleaned = text;

  // Strip outer markdown code blocks that wrap ===FILE=== delimiters
  // e.g. ```\n===FILE: path===\n...\n===END_FILE===\n```
  cleaned = cleaned.replace(/```[\w]*\s*\n(===(?:FILE|EDIT):)/g, "$1");
  cleaned = cleaned.replace(/(===END_(?:FILE|EDIT)===)\s*\n```/g, "$1");

  // Remove backticks around file paths: ===FILE: `src/app/page.tsx`=== → ===FILE: src/app/page.tsx===
  cleaned = cleaned.replace(/===FILE:\s*`([^`]+)`\s*===/g, "===FILE: $1===");
  cleaned = cleaned.replace(/===EDIT:\s*`([^`]+)`\s*===/g, "===EDIT: $1===");

  // Handle ** bold ** around file paths: ===FILE: **src/app/page.tsx**=== → ===FILE: src/app/page.tsx===
  cleaned = cleaned.replace(/===FILE:\s*\*\*([^*]+)\*\*\s*===/g, "===FILE: $1===");

  return cleaned;
}

/**
 * Parse files from Claude's response. Supports multiple formats:
 * 1. ===FILE: path=== ... ===END_FILE===  (full file, new or rewrite)
 * 2. ===EDIT: path=== <<<SEARCH ... >>>REPLACE ... ===END_EDIT===  (search & replace)
 * 3. ```tsx // path/to/file.tsx ... ```  (legacy)
 * 4. // File: path/to/file.tsx ... (next file or end)  (legacy)
 */
function parseFiles(text: string, allowTruncated = false, existingFiles?: { path: string; content: string }[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Pre-process to handle common LLM formatting variations
  const cleanText = preprocessLLMText(text);

  // Format 1: ===FILE: path=== ... ===END_FILE=== (handles \r\n and \n)
  const delimiterRegex = /===FILE:\s*(.+?)===\s*\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = delimiterRegex.exec(cleanText)) !== null) {
    const safePath = sanitizePath(match[1].trim());
    if (safePath) {
      console.log('[parseFiles] Found file via delimiter format:', safePath, 'content length:', match[2].trimEnd().length);
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }

  // Format 1.5: ===EDIT: path=== with SEARCH/REPLACE blocks (safety net)
  const editRegex = /===EDIT:\s*(.+?)===\r?\n([\s\S]*?)===END_EDIT===/g;
  while ((match = editRegex.exec(cleanText)) !== null) {
    const editPath = match[1]?.trim();
    const safePath = editPath ? sanitizePath(editPath) : null;
    if (!safePath) continue;
    // Skip if we already have this file from ===FILE=== format
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
        console.log('[parseFiles] Applied EDIT block for:', safePath, 'edits:', edits.length);
        files.push({ path: safePath, content: result });
      } else {
        console.warn('[parseFiles] EDIT block for unknown file:', safePath);
      }
    }
  }

  // Format 1b: Truncated file — has ===FILE: path=== but NO ===END_FILE===
  // This happens when the response hits max_tokens and gets cut off.
  // BUG FIX: The old regex `([\s\S]+?)$` with `g` only matched the FIRST ===FILE:
  // block, not the LAST truncated one. Now we find the last ===FILE: without a
  // matching ===END_FILE=== by searching backwards from the end.
  if (allowTruncated) {
    const lastFileIdx = cleanText.lastIndexOf("===FILE:");
    if (lastFileIdx !== -1) {
      const tail = cleanText.substring(lastFileIdx);
      // Only process if this block has NO closing delimiter (truly truncated)
      if (!tail.includes("===END_FILE===")) {
        const headerMatch = tail.match(/^===FILE:\s*(.+?)===\n([\s\S]+)$/);
        if (headerMatch) {
          const safePath = sanitizePath(headerMatch[1].trim());
          if (safePath && !files.some(f => f.path === safePath)) {
            const content = headerMatch[2].trimEnd();
            if (content.length >= 100) {
              console.log('[parseFiles] Found TRUNCATED file (last block):', safePath, 'content length:', content.length);
              files.push({ path: safePath, content });
            } else {
              console.warn('[parseFiles] Truncated file too short to recover:', safePath, 'length:', content.length);
            }
          }
        }
      }
    }
  }

  if (files.length > 0) {
    console.log('[parseFiles] Returning', files.length, 'files from delimiter format');
    return files;
  }

  // Format 3: ```language\n// filepath\n...``` or ```language:filepath\n...```
  const codeBlockRegex = /```(?:\w+)?\s*\n?\s*(?:\/\/\s*|\/\*\s*|#\s*)?(?:file:\s*|File:\s*|path:\s*)?([^\n*]+\.\w+)\s*\n([\s\S]*?)```/gi;
  while ((match = codeBlockRegex.exec(cleanText)) !== null) {
    const path = match[1].trim().replace(/^\*\//, "").replace(/\s*\*\/$/, "");
    const safePath = sanitizePath(path);
    if (safePath && (safePath.includes("/") || safePath.includes("."))) {
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }
  if (files.length > 0) return files;

  // Format 4: Look for code blocks with file paths mentioned before them
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

  // Format 5 (LAST RESORT): Extract the largest code block as page.tsx.
  // If Claude completely ignored the ===FILE=== format but still wrote valid React code,
  // grab the biggest code block (must be >200 chars and look like React/JSX).
  const allCodeBlocks: { content: string; lang: string }[] = [];
  const anyCodeBlock = /```(\w*)\n([\s\S]*?)```/g;
  while ((match = anyCodeBlock.exec(cleanText)) !== null) {
    const content = match[2].trimEnd();
    if (content.length > 200) {
      allCodeBlocks.push({ content, lang: match[1] || "" });
    }
  }
  if (allCodeBlocks.length > 0) {
    // Sort by size (largest first) — the biggest block is likely the main page
    allCodeBlocks.sort((a, b) => b.content.length - a.content.length);
    const biggest = allCodeBlocks[0];
    // Sanity check: must look like React code (has export, function, or return with JSX)
    const looksLikeReact = /(?:export\s+default|function\s+\w+|return\s*\()/.test(biggest.content);
    if (looksLikeReact) {
      console.warn('[parseFiles] LAST RESORT: Extracting largest code block as page.tsx (' + biggest.content.length + ' chars)');
      files.push({ path: "src/app/page.tsx", content: biggest.content });
      // Try to extract additional smaller blocks as components
      for (let i = 1; i < allCodeBlocks.length && i < 5; i++) {
        const block = allCodeBlocks[i];
        const exportMatch = block.content.match(/export\s+default\s+function\s+(\w+)/);
        if (exportMatch) {
          const compName = exportMatch[1];
          files.push({ path: `src/components/${compName}.tsx`, content: block.content });
        }
      }
    }
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
  let stopReason = "end_turn"; // Track whether response was truncated

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
          console.log('[useGenerate] Stream stop_reason:', stopReason);
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
  if (wasTruncated) {
    console.warn('[useGenerate] Response was TRUNCATED (hit max_tokens). Attempting to recover partial files...');
  }

  // Try standard parse first
  let finalFiles = parseFiles(fullText, false, existingFiles);

  // ALWAYS attempt recovery when standard parse is incomplete.
  // Claude often outputs ===FILE: path===\n{code} but forgets ===END_FILE===
  // even on end_turn (not just max_tokens). The recovery parser handles this.
  {
    const withRecovery = parseFiles(fullText, true, existingFiles);
    for (const rf of withRecovery) {
      if (!finalFiles.some(f => f.path === rf.path)) {
        console.log('[useGenerate] Recovered unclosed file:', rf.path, 'length:', rf.content.length);
        finalFiles.push(rf);
      }
    }
  }

  // --- "Vanishing Keystone" safety net ---
  // If we have component files but page.tsx is MISSING (truncated away),
  // auto-scaffold a minimal page.tsx that imports and renders the available components.
  const hasPageFile = finalFiles.some(f =>
    f.path.includes("page.tsx") || f.path.includes("page.jsx") ||
    f.path.includes("App.tsx") || f.path.includes("App.jsx")
  );
  const componentFiles = finalFiles.filter(f =>
    f.path.includes("/components/") &&
    (f.path.endsWith(".tsx") || f.path.endsWith(".jsx"))
  );

  if (!hasPageFile && componentFiles.length > 0) {
    console.warn('[useGenerate] VANISHING KEYSTONE detected: page.tsx missing but', componentFiles.length, 'components exist. Auto-scaffolding page.tsx...');

    // Build import lines and component render lines
    const imports: string[] = [];
    const renders: string[] = [];
    for (const cf of componentFiles) {
      // Extract component name from file name (e.g., "src/components/TodoList.tsx" → "TodoList")
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
    console.log('[useGenerate] Auto-scaffolded page.tsx with', componentFiles.length, 'component imports');
  }

  console.log('[useGenerate] Stream complete. Final parse:', { totalFiles: finalFiles.length, lastParsedCount, fullTextLength: fullText.length, stopReason });
  if (finalFiles.length > lastParsedCount) {
    console.log('[useGenerate] Sending remaining files to onFileGenerated');
    for (let i = lastParsedCount; i < finalFiles.length; i++) {
      console.log('[useGenerate] Final onFileGenerated:', finalFiles[i].path);
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
      errMsg = `Response was truncated (hit token limit). The app may be too complex for a single generation. Try a simpler prompt or break it into steps.`;
    } else {
      // Log diagnostic info to help debug parsing failures
      const hasFileDelimiter = fullText.includes("===FILE:");
      const hasEndFile = fullText.includes("===END_FILE===");
      const hasCodeBlock = fullText.includes("```");
      const first500 = fullText.substring(0, 500);
      console.error('[useGenerate] PARSE FAILURE — Could not extract files from LLM response.');
      console.error('[useGenerate] Diagnostic:', { length: fullText.length, hasFileDelimiter, hasEndFile, hasCodeBlock });
      console.error('[useGenerate] First 500 chars:', first500);
      errMsg = `Claude responded but output could not be parsed into files. Raw: ${fullText.length} chars.${hasFileDelimiter && !hasEndFile ? ' Found ===FILE: but no ===END_FILE=== — response may have been cut off.' : ''}`;
    }
    return { files: [], error: errMsg };
  }

  return { files: finalFiles, error: wasTruncated ? null : null };
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

      // Flatten the tree so we can look up existing file content for EDIT operations
      // and filter out default placeholder files.
      const flatFiles = flattenForContext(existingFiles);
      const contextFiles = flatFiles.filter(
        (f) => !f.content.includes("// Your generated code will appear here")
      );

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
          body: JSON.stringify({ prompt, existingFiles: contextFiles }),
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
            contextFiles,
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
