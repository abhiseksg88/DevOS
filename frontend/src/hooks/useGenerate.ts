"use client";

import { useCallback, useRef, useState } from "react";
import type { FileNode } from "@/types";

interface GeneratedFile {
  path: string;
  content: string;
}

interface GenerateState {
  isGenerating: boolean;
  streamedText: string;
  files: GeneratedFile[];
  error: string | null;
}

/** Parse ===FILE: path=== ... ===END_FILE=== blocks from streamed text */
function parseFiles(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const regex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1].trim();
    const content = match[2].trimEnd();
    files.push({ path, content });
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
      onFileGenerated: (path: string, content: string) => void
    ) => {
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
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          setState((prev) => ({
            ...prev,
            isGenerating: false,
            error: err.error || "Generation failed",
          }));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          setState((prev) => ({ ...prev, isGenerating: false, error: "No response stream" }));
          return;
        }

        const decoder = new TextDecoder();
        let fullText = "";
        let lastParsedCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE events
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6);
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
                setState((prev) => ({ ...prev, error: event.error }));
              }
            } catch {
              // skip malformed JSON
            }
          }
        }

        // Final parse for any remaining files
        const finalFiles = parseFiles(fullText);
        if (finalFiles.length > lastParsedCount) {
          for (let i = lastParsedCount; i < finalFiles.length; i++) {
            onFileGenerated(finalFiles[i].path, finalFiles[i].content);
          }
        }

        setState((prev) => ({
          ...prev,
          isGenerating: false,
          files: finalFiles,
        }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          isGenerating: false,
          error: err instanceof Error ? err.message : "Generation failed",
        }));
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
