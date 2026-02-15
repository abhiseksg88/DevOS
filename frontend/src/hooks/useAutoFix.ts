"use client";

import { useCallback, useRef, useState } from "react";
import type { FileNode } from "@/types";

interface FixState {
  isFixing: boolean;
  iteration: number;
  maxIterations: number;
  lastError: string | null;
}

interface GeneratedFile {
  path: string;
  content: string;
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
 * Parse files from the LLM fix response.
 * Supports ===FILE: path=== ... ===END_FILE=== format.
 */
function parseFixFiles(text: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const regex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1].trim();
    if (path && !path.startsWith("/") && !path.includes("..")) {
      files.push({ path, content: match[2].trimEnd() });
    }
  }
  return files;
}

const MAX_ITERATIONS = 3;
const DEBOUNCE_MS = 1500; // Wait 1.5s for errors to settle

/**
 * Auto-fix hook: captures preview errors, sends them to the fix agent,
 * applies the fix, and re-renders. Loops up to 3 times.
 */
export function useAutoFix(
  fileTree: FileNode[],
  onFileFix: (path: string, content: string) => void,
  onFixStart: () => void,
  onFixEnd: (success: boolean, iteration: number) => void,
) {
  const [state, setState] = useState<FixState>({
    isFixing: false,
    iteration: 0,
    maxIterations: MAX_ITERATIONS,
    lastError: null,
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorsRef = useRef<string[]>([]);
  const iterationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;

  // Collect errors with debounce — wait for all errors to arrive
  const reportError = useCallback(
    (errorMessage: string) => {
      // Don't capture during a fix attempt
      if (state.isFixing) return;

      // Deduplicate
      if (!errorsRef.current.includes(errorMessage)) {
        errorsRef.current.push(errorMessage);
      }

      // Debounce: wait 1.5s for more errors before triggering fix
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (errorsRef.current.length > 0 && iterationRef.current < MAX_ITERATIONS) {
          triggerFix();
        }
      }, DEBOUNCE_MS);
    },
    [state.isFixing],
  );

  const triggerFix = useCallback(async () => {
    const errors = [...errorsRef.current];
    errorsRef.current = [];

    if (errors.length === 0) return;

    iterationRef.current += 1;
    const iteration = iterationRef.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({
      isFixing: true,
      iteration,
      maxIterations: MAX_ITERATIONS,
      lastError: errors[0],
    });
    onFixStart();

    try {
      const errorList = errors
        .slice(0, 5) // Max 5 errors to keep context focused
        .map((e, i) => `${i + 1}. ${e}`)
        .join("\n");

      const prompt = `Fix these runtime errors from the preview render:\n\n${errorList}\n\nThis is auto-fix iteration ${iteration}/${MAX_ITERATIONS}. Fix ALL the errors.`;

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          existingFiles: flattenForContext(fileTreeRef.current),
          mode: "fix",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Fix request failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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
            } else if (event.type === "error") {
              throw new Error(event.error);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue; // skip malformed JSON
            throw e;
          }
        }
      }

      // Parse and apply fixes
      const fixedFiles = parseFixFiles(fullText);
      if (fixedFiles.length > 0) {
        for (const file of fixedFiles) {
          onFileFix(file.path, file.content);
        }
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEnd(true, iteration);
      } else {
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEnd(false, iteration);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState((prev) => ({ ...prev, isFixing: false }));
      onFixEnd(false, iterationRef.current);
    }
  }, [onFileFix, onFixStart, onFixEnd]);

  // Reset iteration counter (call when user sends a new prompt)
  const reset = useCallback(() => {
    iterationRef.current = 0;
    errorsRef.current = [];
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setState({
      isFixing: false,
      iteration: 0,
      maxIterations: MAX_ITERATIONS,
      lastError: null,
    });
  }, []);

  return { ...state, reportError, reset };
}
