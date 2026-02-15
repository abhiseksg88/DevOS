"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useProject } from "@/hooks/useProject";
import { useBuildStream } from "@/hooks/useBuildStream";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { FileTree } from "@/components/editor/FileTree";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { BuildLog } from "@/components/build/BuildLog";
import type { ChatMessage, FileNode } from "@/types";
import {
  Zap,
  ArrowLeft,
  Code2,
  Eye,
  Terminal,
  Loader2,
  Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";

type RightTab = "code" | "preview" | "console";

export function Workspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { project, tenantId, loading, createBuild, getToken } = useProject(projectId);
  const buildStream = useBuildStream();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("code");
  const [activeFile, setActiveFile] = useState<FileNode | null>(null);
  const [openFiles, setOpenFiles] = useState<FileNode[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Demo file tree — in production this comes from the build output
  const [fileTree] = useState<FileNode[]>([
    {
      name: "src",
      path: "src",
      type: "directory",
      children: [
        {
          name: "app",
          path: "src/app",
          type: "directory",
          children: [
            {
              name: "page.tsx",
              path: "src/app/page.tsx",
              type: "file",
              language: "typescriptreact",
              content: '// Your generated code will appear here\nexport default function Home() {\n  return (\n    <main className="min-h-screen flex items-center justify-center">\n      <h1>Welcome to NimbusForge</h1>\n    </main>\n  );\n}',
            },
            {
              name: "layout.tsx",
              path: "src/app/layout.tsx",
              type: "file",
              language: "typescriptreact",
              content: 'import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}',
            },
            {
              name: "globals.css",
              path: "src/app/globals.css",
              type: "file",
              language: "css",
              content: "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
            },
          ],
        },
        {
          name: "components",
          path: "src/components",
          type: "directory",
          children: [],
        },
      ],
    },
    {
      name: "package.json",
      path: "package.json",
      type: "file",
      language: "json",
      content: '{\n  "name": "my-app",\n  "version": "0.1.0",\n  "dependencies": {\n    "next": "14.2.0",\n    "react": "^18.3.0"\n  }\n}',
    },
  ]);

  const handleFileSelect = useCallback((file: FileNode) => {
    if (file.type !== "file") return;
    setActiveFile(file);
    setOpenFiles((prev) => {
      if (prev.some((f) => f.path === file.path)) return prev;
      return [...prev, file];
    });
    setRightTab("code");
  }, []);

  const handleCloseFile = useCallback(
    (path: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.path !== path));
      if (activeFile?.path === path) {
        setActiveFile(openFiles.find((f) => f.path !== path) ?? null);
      }
    },
    [activeFile, openFiles]
  );

  const handleSendMessage = useCallback(
    async (content: string) => {
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const build = await createBuild(content);

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Building your request... I'll plan the architecture, write the code, and deploy a preview.`,
          timestamp: Date.now(),
          buildId: build.id,
          status: build.status,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // Start SSE stream
        const token = await getToken();
        buildStream.startStream(token, tenantId, projectId, build.id);

        // Switch to console to show build progress
        setRightTab("console");
      } catch (err) {
        const errMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Build failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errMsg]);
      }
    },
    [createBuild, buildStream, tenantId, projectId, getToken]
  );

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-0">
        <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-surface-0">
      {/* Top bar */}
      <header className="h-12 border-b border-surface-3 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard")}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-2 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-surface-3" />
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-brand-500 flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-medium text-white">
              {project?.name ?? "Project"}
            </span>
          </div>
          {buildStream.isStreaming && (
            <div className="flex items-center gap-1.5 ml-3 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
              <span className="text-2xs text-amber-400 font-medium uppercase tracking-wider">
                Building
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-all"
            >
              <Rocket className="w-3 h-3" />
              Live
            </a>
          )}
        </div>
      </header>

      {/* Main workspace — 3 panels */}
      <PanelGroup direction="horizontal" className="flex-1">
        {/* Panel 1: Chat */}
        <Panel defaultSize={30} minSize={20} maxSize={45}>
          <ChatPanel
            messages={messages}
            onSendMessage={handleSendMessage}
            isStreaming={buildStream.isStreaming}
            buildEvents={buildStream.events}
          />
        </Panel>

        <PanelResizeHandle />

        {/* Panel 2: Code + Preview + Console (tabbed) */}
        <Panel defaultSize={70} minSize={40}>
          <div className="h-full flex flex-col">
            {/* Tabs */}
            <div className="h-10 border-b border-surface-3 flex items-center px-2 gap-1 shrink-0">
              {(
                [
                  { key: "code", icon: Code2, label: "Code" },
                  { key: "preview", icon: Eye, label: "Preview" },
                  { key: "console", icon: Terminal, label: "Console" },
                ] as const
              ).map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => setRightTab(key)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                    rightTab === key
                      ? "bg-surface-3 text-white"
                      : "text-slate-500 hover:text-slate-300 hover:bg-surface-2"
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                  {key === "console" && buildStream.isStreaming && (
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden">
              {rightTab === "code" && (
                <PanelGroup direction="horizontal">
                  {/* File tree */}
                  <Panel defaultSize={25} minSize={15} maxSize={40}>
                    <FileTree
                      files={fileTree}
                      activeFile={activeFile}
                      onSelect={handleFileSelect}
                    />
                  </Panel>
                  <PanelResizeHandle />
                  {/* Editor */}
                  <Panel defaultSize={75}>
                    <CodeEditor
                      file={activeFile}
                      openFiles={openFiles}
                      onSelectFile={(f) => setActiveFile(f)}
                      onCloseFile={handleCloseFile}
                    />
                  </Panel>
                </PanelGroup>
              )}

              {rightTab === "preview" && (
                <PreviewPane url={previewUrl} />
              )}

              {rightTab === "console" && (
                <BuildLog
                  events={buildStream.events}
                  isStreaming={buildStream.isStreaming}
                  status={buildStream.status}
                />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
