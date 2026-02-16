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

interface GenerateState {
  isGenerating: boolean;
  streamedText: string;
  files: GeneratedFile[];
  error: string | null;
}

/**
 * Parse files from Claude's response. Supports multiple formats:
 * 1. ===FILE: path=== ... ===END_FILE===
 * 2. ```tsx // path/to/file.tsx ... ```
 * 3. // File: path/to/file.tsx ... (next file or end)
 */
/** Sanitize file path to prevent directory traversal */
function sanitizePath(path: string): string | null {
  // Remove null bytes
  let clean = path.replace(/\0/g, "");
  // Normalize separators
  clean = clean.replace(/\\/g, "/");
  // Remove leading slashes (absolute paths)
  clean = clean.replace(/^\/+/, "");
  // Reject paths with .. traversal
  if (clean.includes("..")) return null;
  // Reject paths that try to escape (e.g., starting with ~)
  if (clean.startsWith("~")) return null;
  // Must be a reasonable file path
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
    // Only accept paths that look like file paths
    const safePath = sanitizePath(path);
    if (safePath && (safePath.includes("/") || safePath.includes("."))) {
      files.push({ path: safePath, content: match[2].trimEnd() });
    }
  }
  if (files.length > 0) return files;

  // Format 3: Look for code blocks with file paths mentioned before them
  const sections = text.split(/(?=###?\s|(?:^|\n)(?:\*\*)?(?:File|`)[:\s])/);
  for (const section of sections) {
    // Find a file path reference
    const pathMatch = section.match(
      /(?:###?\s*|(?:\*\*)?(?:File|`)[:\s]*\s*)([`"]?)([a-zA-Z][\w./\-]+\.\w{1,10})\1/
    );
    if (!pathMatch) continue;

    // Find the code block in this section
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

export function useGenerate() {
  const [state, setState] = useState<GenerateState>({
    isGenerating: false,
    streamedText: "",
    files: [],
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const generate = useCallback(
    async (
      prompt: string,
      existingFiles: FileNode[],
      onFileGenerated: (path: string, content: string) => void,
      chatHistory?: Array<{ role: string; content: string }>
    ): Promise<GenerateResult> => {
      // Cancel any ongoing generation
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ isGenerating: true, streamedText: "", files: [], error: null });

      try {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            existingFiles: flattenForContext(existingFiles),
            messages: chatHistory,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          let errMsg = `Generation failed (HTTP ${response.status})`;
          try {
            const err = await response.json();
            errMsg = err.error || errMsg;
          } catch {
            // Response wasn't JSON — try reading as text for debugging
            try {
              const text = await response.text();
              if (text.includes("<!DOCTYPE") || text.includes("<html")) {
                errMsg = `Server returned an HTML error page (HTTP ${response.status}). The API route may not be deployed correctly.`;
              }
            } catch {
              // ignore
            }
          }
          setState((prev) => ({ ...prev, isGenerating: false, error: errMsg }));
          return { files: [], error: errMsg };
        }

        // Validate that we got an SSE stream, not an HTML page
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream") && !contentType.includes("text/plain")) {
          const body = await response.text();
          let errMsg = `Unexpected response type: ${contentType || "unknown"}`;
          if (body.includes("<!DOCTYPE") || body.includes("<html")) {
            errMsg = "Server returned an HTML page instead of a code generation stream. The API route may not be deployed correctly.";
          }
          setState((prev) => ({ ...prev, isGenerating: false, error: errMsg }));
          return { files: [], error: errMsg };
        }

        const reader = response.body?.getReader();
        if (!reader) {
          const errMsg = "No response stream";
          setState((prev) => ({ ...prev, isGenerating: false, error: errMsg }));
          return { files: [], error: errMsg };
        }

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

          // Process complete lines from buffer
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            try {
              const event = JSON.parse(jsonStr);
              if (event.type === "text") {
                fullText += event.content;
                setState((prev) => ({ ...prev, streamedText: fullText }));

                // Check for newly completed files
                const parsed = parseFiles(fullText);
                if (parsed.length > lastParsedCount) {
                  for (let i = lastParsedCount; i < parsed.length; i++) {
                    onFileGenerated(parsed[i].path, parsed[i].content);
                  }
                  lastParsedCount = parsed.length;
                  setState((prev) => ({ ...prev, files: parsed }));
                }
              } else if (event.type === "error") {
                const errMsg = event.error || "Generation error";
                setState((prev) => ({ ...prev, isGenerating: false, error: errMsg }));
                return { files: [], error: errMsg };
              }
            } catch {
              // skip malformed JSON
            }
          }
        }

        // Process any remaining buffer
        if (buffer.startsWith("data: ")) {
          try {
            const event = JSON.parse(buffer.slice(6).trim());
            if (event.type === "text") {
              fullText += event.content;
            }
          } catch {
            // ignore
          }
        }

        // Final parse for any remaining files
        const finalFiles = parseFiles(fullText);
        if (finalFiles.length > lastParsedCount) {
          for (let i = lastParsedCount; i < finalFiles.length; i++) {
            onFileGenerated(finalFiles[i].path, finalFiles[i].content);
          }
        }

        // If the stream completed but produced no files, report a clear error
        if (finalFiles.length === 0) {
          let errMsg: string;
          if (rawBytes === 0) {
            errMsg = "The API returned an empty response. This usually means the server function timed out or the ANTHROPIC_API_KEY is not configured. Check your Netlify environment variables.";
          } else if (fullText.length === 0) {
            errMsg = `Received ${rawBytes} bytes from server but no text content was extracted. The stream may have been interrupted.`;
          } else {
            errMsg = `Claude responded but the output could not be parsed into files. Raw length: ${fullText.length} chars.`;
          }
          setState((prev) => ({ ...prev, isGenerating: false, error: errMsg, streamedText: fullText }));
          return { files: [], error: errMsg };
        }

        setState((prev) => ({
          ...prev,
          isGenerating: false,
          files: finalFiles,
          streamedText: fullText,
        }));

        return { files: finalFiles, error: null };
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return { files: [], error: null };
        }
        const errMsg = err instanceof Error ? err.message : "Generation failed";
        setState((prev) => ({
          ...prev,
          isGenerating: false,
          error: errMsg,
        }));
        return { files: [], error: errMsg };
      }
    },
    []
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, isGenerating: false }));
  }, []);

  return { ...state, generate, stop };
}
