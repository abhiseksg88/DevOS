"use client";

import { useCallback, useRef, useState } from "react";
import type { FileNode } from "@/types";
import { logPreviewError, logAutoFixStart, logAutoFixResult } from "@/lib/error-log";

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

  // AUTO-CLOSE: Same logic as useGenerate.ts — if the last ===FILE: block
  // lacks ===END_FILE===, append it so the regex can match.
  let textToParse = text;
  const lastFileStart = text.lastIndexOf("===FILE:");
  if (lastFileStart !== -1) {
    const textAfterLast = text.substring(lastFileStart);
    if (!textAfterLast.includes("===END_FILE===")) {
      console.warn("[useAutoFix] AUTO-CLOSE: Appending ===END_FILE=== to unclosed block");
      textToParse = text.trimEnd() + "\n===END_FILE===";
    }
  }

  // Format 1: ===FILE: path=== ... ===END_FILE=== (full file replacement)
  const fileRegex = /===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE===/g;
  let match;
  while ((match = fileRegex.exec(textToParse)) !== null) {
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

const MAX_ITERATIONS = 5;
const DEBOUNCE_MS = 1200; // Wait 1.2s for errors to settle

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
    logAutoFixStart(iteration, errors);

    try {
      const errorList = errors
        .slice(0, 5) // Max 5 errors to keep context focused
        .map((e, i) => `${i + 1}. ${e}`)
        .join("\n");

      // Detect if this is a syntax/truncation error vs a runtime error
      const isSyntaxError = errors.some(e =>
        e.includes("Unterminated string") ||
        e.includes("Unexpected token") ||
        e.includes("SyntaxError") ||
        e.includes("Unexpected end of input")
      );

      // Escalating simplification pressure — each iteration demands shorter code
      let simplificationDirective = "";
      if (iteration >= 4) {
        simplificationDirective = `\n\nCRITICAL — ATTEMPT ${iteration}/${MAX_ITERATIONS}: Previous fixes were ALSO truncated. You MUST:\n- Strip the UI to ABSOLUTE MINIMUM: one form + one list/table, no extra styling\n- Target UNDER 80 lines total. Remove ALL decorative elements.\n- Use plain <input>, <button>, <table> with minimal Tailwind\n- NO gradients, shadows, cards, modals, tabs — just raw functional UI\n- Working code > pretty code. Ship it ugly but complete.`;
      } else if (iteration >= 3) {
        simplificationDirective = `\n\nWARNING — ATTEMPT ${iteration}: Previous fix was STILL too long and got truncated. SIMPLIFY AGGRESSIVELY:\n- Target UNDER 120 lines. Remove decorative UI (gradients, shadows, complex layouts)\n- Use simple <table> instead of cards. Use emoji instead of SVG icons.\n- Combine related state. Remove optional features (search, filter, sort).`;
      } else if (iteration >= 2) {
        simplificationDirective = `\n\nNOTE — ATTEMPT ${iteration}: The previous fix also failed (likely truncated). Keep the file UNDER 180 lines. Simplify the UI — remove non-essential visual polish.`;
      }

      const syntaxFixGuidance = isSyntaxError
        ? `\n\nSYNTAX ERROR DETECTED — This is likely caused by TRUNCATED code (the file was cut off mid-line by token limits). You MUST:\n1. Output the COMPLETE file from start to finish — do NOT skip or abbreviate any section\n2. Make sure EVERY string literal is closed, EVERY JSX tag is closed, EVERY function body has its closing brace\n3. If the file is too long, SIMPLIFY the UI to fit. Remove decorative elements, reduce table columns, simplify forms. Working > pretty.${simplificationDirective}`
        : simplificationDirective;

      const prompt = `Fix these preview errors:\n\n${errorList}\n\nThis is auto-fix iteration ${iteration}/${MAX_ITERATIONS}. Fix ALL the errors.${syntaxFixGuidance}\n\nCOMMON FIXES:\n- "Unterminated string constant" or "Unexpected token" → CODE WAS TRUNCATED. Regenerate the COMPLETE file, keeping it under 250 lines. Simplify UI if needed.\n- "onSubmit is not a function" or "onAdd is not a function" → PROP NAME MISMATCH. MERGE all components into a single page.tsx file.\n- "Cannot read properties of undefined" → Add optional chaining: obj?.X or default values: { items = [] }\n- "X is not a function" → MERGE components into a single file.\n- All array props MUST have defaults: { cases = [], items = [], data = [] }\n- All data from queries must use (data || []) guard before .map(), .filter(), .length\n\nSINGLE-FILE CRUD RULE: Put ALL CRUD code in page.tsx — state, database calls, form, table. No separate components.\n\nDATABASE: Use window.supabase.from('app_data') for CRUD. Include tenant_id: window.__VEDAA_TENANT_ID, project_id: window.__VEDAA_PROJECT_ID, app_instance_id: window.__VEDAA_APP_INSTANCE_ID in INSERT. Filter by .eq('project_id', window.__VEDAA_PROJECT_ID) in READ/UPDATE/DELETE.\n\nIMPORTANT: Output COMPLETE fixed files using ===FILE: path=== format. Every file MUST end with ===END_FILE===. Do not output partial snippets.`;

      // For syntax/truncation errors on iteration 2+, send only the broken file
      // to minimize input tokens and maximize output budget
      let contextFiles = flattenForContext(fileTreeRef.current);
      if (isSyntaxError && iteration >= 2) {
        const errorPath = errors[0]?.match(/\/?([\w/.]+\.tsx?):/)?.[1];
        const normalizedPath = errorPath
          ? (errorPath.startsWith("src/") ? errorPath : `src/app/${errorPath}`)
          : "src/app/page.tsx";
        const filtered = contextFiles.filter(
          f => f.path === normalizedPath || f.path === "src/app/page.tsx"
        );
        if (filtered.length > 0) contextFiles = filtered;
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          existingFiles: contextFiles,
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
        logAutoFixResult(iteration, true, fixedFiles.map(f => f.path));
        for (const file of fixedFiles) {
          onFileFixRef.current(file.path, file.content);
        }
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEndRef.current(true, iteration);
      } else {
        logAutoFixResult(iteration, false);
        setState((prev) => ({ ...prev, isFixing: false }));
        onFixEndRef.current(false, iteration);
      }
    } catch (err) {
      isFixingRef.current = false;
      if ((err as Error).name === "AbortError") return;
      logAutoFixResult(iterationRef.current, false);
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
        logPreviewError(errorMessage);
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
