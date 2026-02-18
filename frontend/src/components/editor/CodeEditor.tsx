"use client";

import { useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import type { FileNode } from "@/types";
import { cn, getLanguageFromPath } from "@/lib/utils";
import { X, FileCode2 } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";

// Lazy load Monaco to avoid SSR issues
const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full bg-surface-0">
      <div className="text-sm text-slate-600">Loading editor...</div>
    </div>
  ),
});

interface CodeEditorProps {
  file: FileNode | null;
  openFiles: FileNode[];
  onSelectFile: (file: FileNode) => void;
  onCloseFile: (path: string) => void;
  onContentChange?: (path: string, content: string) => void;
}

export function CodeEditor({ file, openFiles, onSelectFile, onCloseFile, onContentChange }: CodeEditorProps) {
  const { theme } = useTheme();
  const monacoRef = useRef<{ editor: { defineTheme: (name: string, theme: unknown) => void; setTheme: (name: string) => void } } | null>(null);

  const handleEditorMount = useCallback((editor: unknown, monaco: unknown) => {
    const m = monaco as typeof monacoRef.current;
    monacoRef.current = m;
    if (!m) return;

    // Dark theme
    m.editor.defineTheme("vedaa-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6a6a8e", fontStyle: "italic" },
        { token: "keyword", foreground: "c792ea" },
        { token: "string", foreground: "c3e88d" },
        { token: "number", foreground: "f78c6c" },
        { token: "type", foreground: "ffcb6b" },
        { token: "function", foreground: "82aaff" },
        { token: "variable", foreground: "f07178" },
      ],
      colors: {
        "editor.background": "#0a0a0f",
        "editor.foreground": "#d4d4e0",
        "editor.lineHighlightBackground": "#1a1a2510",
        "editor.selectionBackground": "#8b5cf630",
        "editorCursor.foreground": "#8b5cf6",
        "editorLineNumber.foreground": "#3a3a4a",
        "editorLineNumber.activeForeground": "#8b5cf6",
        "editor.inactiveSelectionBackground": "#3a3a4a30",
        "editorIndentGuide.background1": "#1a1a25",
        "editorIndentGuide.activeBackground1": "#2a2a3a",
        "editorWidget.background": "#12121a",
        "editorWidget.border": "#2a2a3a",
      },
    });

    // Light theme — clean, minimal
    m.editor.defineTheme("vedaa-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "94a3b8", fontStyle: "italic" },
        { token: "keyword", foreground: "7c3aed" },
        { token: "string", foreground: "16a34a" },
        { token: "number", foreground: "ea580c" },
        { token: "type", foreground: "d97706" },
        { token: "function", foreground: "2563eb" },
        { token: "variable", foreground: "dc2626" },
      ],
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#1e293b",
        "editor.lineHighlightBackground": "#f8fafc",
        "editor.selectionBackground": "#8b5cf625",
        "editorCursor.foreground": "#7c3aed",
        "editorLineNumber.foreground": "#cbd5e1",
        "editorLineNumber.activeForeground": "#7c3aed",
        "editor.inactiveSelectionBackground": "#e2e8f015",
        "editorIndentGuide.background1": "#f1f5f9",
        "editorIndentGuide.activeBackground1": "#e2e8f0",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#e2e8f0",
      },
    });

    m.editor.setTheme(theme === "dark" ? "vedaa-dark" : "vedaa-light");
  }, [theme]);

  // Switch Monaco theme when app theme changes
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(theme === "dark" ? "vedaa-dark" : "vedaa-light");
    }
  }, [theme]);

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-surface-0">
        <FileCode2 className="w-12 h-12 text-slate-700 mb-4" />
        <p className="text-slate-600 text-sm">Select a file to start editing</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Tabs */}
      <div className="h-8 flex items-center bg-surface-1 border-b border-surface-3 overflow-x-auto">
        {openFiles.map((f) => (
          <div
            key={f.path}
            onClick={() => onSelectFile(f)}
            className={cn(
              "flex items-center gap-1.5 px-3 h-full text-xs border-r border-surface-3 cursor-pointer transition-colors shrink-0 group",
              f.path === file.path
                ? "bg-surface-0 text-foreground border-b-2 border-b-brand-500"
                : "text-slate-500 hover:text-slate-300 hover:bg-surface-2"
            )}
          >
            <span className="truncate max-w-[120px]">{f.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseFile(f.path);
              }}
              className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-surface-3 transition-all"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Monaco */}
      <div className="flex-1">
        <MonacoEditor
          language={getLanguageFromPath(file.path)}
          value={file.content ?? ""}
          theme={theme === "dark" ? "vedaa-dark" : "vedaa-light"}
          onMount={handleEditorMount}
          onChange={(value) => {
            if (value !== undefined && onContentChange) {
              onContentChange(file.path, value);
            }
          }}
          options={{
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontLigatures: true,
            lineHeight: 22,
            minimap: { enabled: false },
            padding: { top: 16, bottom: 16 },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "line",
            bracketPairColorization: { enabled: true },
            guides: { indentation: true, bracketPairs: true },
            wordWrap: "on",
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
