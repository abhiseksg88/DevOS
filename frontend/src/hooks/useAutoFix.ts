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
 * Supports both ===FILE=== (full file) and ===EDIT=== (search/replace) formats.
 */
function parseFixFiles(text: string, existingFiles: FileNode[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Format 1: ===FILE: path=== ... ===END_FILE=== (full file replacement)
  const fileRegex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    const path = match[1].trim();
    if (path && !path.startsWith("/") && !path.includes("..")) {
      files.push({ path, content: match[2].trimEnd() });
    }
  }

  // Format 2: ===EDIT: path=== with SEARCH/REPLACE blocks
  const editRegex = /===EDIT:\s*(.+?)===\r?\n([\s\S]*?)===END_EDIT===/g;
  while ((match = editRegex.exec(text)) !== null) {
    const path = match[1]?.trim();
    if (!path || path.startsWith("/") || path.includes("..")) continue;

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

    if (edits.length > 0) {
      // Find existing file content and apply edits
      const findContent = (nodes: FileNode[]): string | null => {
        for (const node of nodes) {
          if (node.type === "file" && node.path === path) return node.content ?? null;
          if (node.children) {
            const found = findContent(node.children);
            if (found !== null) return found;
          }
        }
        return null;
      };

      const original = findContent(existingFiles);
      if (original) {
        let content = original;
        for (const edit of edits) {
          if (edit.search && content.includes(edit.search)) {
            content = content.replace(edit.search, edit.replace);
          }
        }
        files.push({ path, content });
      }
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
  const isFixingRef = useRef(false);

  // Use refs to avoid stale closures in setTimeout callbacks
  const fileTreeRef = useRef(fileTree);
  fileTreeRef.current = fileTree;
  const onFileFixRef = useRef(onFileFix);
  onFileFixRef.current = onFileFix;
  const onFixStartRef = useRef(onFixStart);
  onFixStartRef.current = onFixStart;
  const onFixEndRef = useRef(onFixEnd);
  onFixEndRef.current = onFixEnd;

  const triggerFix = useCallback(async () => {
    const errors = [...errorsRef.current];
    errorsRef.current = [];

    if (errors.length === 0) return;

    iterationRef.current += 1;
    const iteration = iterationRef.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    isFixingRef.current = true;
    setState({
      isFixing: true,
      iteration,
      maxIterations: MAX_ITERATIONS,
      lastError: errors[0],
    });
    onFixStartRef.current();

    try {
      const errorList = errors
        .slice(0, 5) // Max 5 errors to keep context focused
        .map((e, i) => `${i + 1}. ${e}`)
        .join("\n");

      const prompt = `Fix these runtime errors from the preview render:\n\n${errorList}\n\nThis is auto-fix iteration ${iteration}/${MAX_ITERATIONS}. Fix ALL the errors.\n\nCOMMON FIXES:\n- "onSubmit is not a function" or "onAdd is not a function" → PROP NAME MISMATCH between parent and child component. The BEST fix: MERGE all components into a single page.tsx file. Move the form, table, and all CRUD functions into page.tsx directly. Remove child component imports. This eliminates prop wiring entirely.\n- "Cannot read properties of undefined (reading 'length')" or ".map()" → The component receives an undefined prop. Add default values: function Component({ items = [] }) or use (items || []).length\n- "Cannot read properties of undefined (reading 'X')" → Add optional chaining: obj?.X or provide default objects in destructuring\n- "X is not a function" → Likely a prop callback that was never passed from the parent. MERGE components into a single file instead of trying to fix prop wiring.\n- All array props MUST have defaults: { cases = [], items = [], data = [] }\n- All data from database queries must use (data || []) guard before .map(), .filter(), .length\n\nSINGLE-FILE CRUD RULE: If the app involves CRUD (add/edit/delete items), put ALL code in page.tsx — state, database calls (window.supabase), form handling, table rendering. Do NOT use separate component files for CRUD apps. This prevents prop name mismatches.\n\nDATABASE: Use window.supabase.from('app_data') for all CRUD. Include tenant_id: window.__VEDAA_TENANT_ID, project_id: window.__VEDAA_PROJECT_ID, app_instance_id: window.__VEDAA_APP_INSTANCE_ID in INSERT. Filter by .eq('project_id', window.__VEDAA_PROJECT_ID) in READ/UPDATE/DELETE.\n\nIMPORTANT: Output COMPLETE fixed files using ===FILE: path=== format. Do not output partial snippets.`;

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
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Parse and apply fixes (pass existing files for EDIT block resolution)
      const fixedFiles = parseFixFiles(fullText, fileTreeRef.current);
      isFixingRef.current = false;
      if (fixedFiles.length > 0) {
        for (const file of fixedFiles) {
          onFileFixRef.current(file.path, file.content);
        }
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEndRef.current(true, iteration);
      } else {
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEndRef.current(false, iteration);
      }
    } catch (err) {
      isFixingRef.current = false;
      if ((err as Error).name === "AbortError") return;
      setState((prev) => ({ ...prev, isFixing: false }));
      onFixEndRef.current(false, iterationRef.current);
    }
  }, []); // Stable — uses refs for all external values

  // Collect errors with debounce — wait for all errors to arrive
  const reportError = useCallback(
    (errorMessage: string) => {
      // Don't capture during a fix attempt (use ref for freshness)
      if (isFixingRef.current) return;

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
    [triggerFix],
  );

  // Reset iteration counter (call when user sends a new prompt)
  const reset = useCallback(() => {
    iterationRef.current = 0;
    errorsRef.current = [];
    isFixingRef.current = false;
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
