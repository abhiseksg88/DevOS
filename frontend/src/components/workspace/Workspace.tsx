"use client";

import { useState, useCallback, useEffect } from "react";
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

/** Helper: flatten file tree into a flat array */
function flattenTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") result.push(node);
    if (node.children) result.push(...flattenTree(node.children));
  }
  return result;
}

/** Helper: update a file's content in a tree */
function updateInTree(nodes: FileNode[], path: string, content: string): FileNode[] {
  return nodes.map((node) => {
    if (node.type === "file" && node.path === path) {
      return { ...node, content };
    }
    if (node.children) {
      return { ...node, children: updateInTree(node.children, path, content) };
    }
    return node;
  });
}

export function Workspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { project, tenantId, loading, createBuild, getToken } = useProject(projectId);
  const buildStream = useBuildStream();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("code");
  const [activeFile, setActiveFile] = useState<FileNode | null>(null);
  const [openFiles, setOpenFiles] = useState<FileNode[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // File tree — updated from build output or editor changes
  const [fileTree, setFileTree] = useState<FileNode[]>([
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

  /** Update a file's content in the tree */
  const updateFileContent = useCallback((path: string, content: string) => {
    setFileTree((prev) => updateInTree(prev, path, content));
    setActiveFile((prev) => (prev?.path === path ? { ...prev, content } : prev));
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
  }, []);

  /** Add or update a file in the tree from build output */
  const addFileToTree = useCallback((path: string, content: string, language?: string) => {
    const parts = path.split("/");
    const fileName = parts[parts.length - 1];

    const ext = fileName.split(".").pop() ?? "";
    const langMap: Record<string, string> = {
      tsx: "typescriptreact", jsx: "javascriptreact",
      ts: "typescript", js: "javascript",
      css: "css", json: "json", html: "html",
      py: "python", go: "go", rs: "rust", md: "markdown",
    };
    const detectedLang = language ?? langMap[ext] ?? "plaintext";

    setFileTree((prev) => {
      const flat = flattenTree(prev);
      if (flat.some((f) => f.path === path)) {
        return updateInTree(prev, path, content);
      }
      // Build directory structure for the new file
      return addToDirectory(prev, parts, 0, content, detectedLang);
    });
  }, []);

  // Process build events to update file tree and preview
  useEffect(() => {
    if (buildStream.events.length === 0) return;
    const lastEvent = buildStream.events[buildStream.events.length - 1];

    // Handle "patch" events that contain file changes
    if (lastEvent.kind === "patch" && lastEvent.payload) {
      const payload = lastEvent.payload as Record<string, unknown>;
      const filePath = (payload.path ?? payload.file_path ?? payload.filename) as string | undefined;
      const fileContent = (payload.content ?? payload.code ?? payload.source) as string | undefined;
      if (filePath && fileContent) {
        addFileToTree(filePath, fileContent);
        setRightTab("preview");
      }
    }

    // Handle build completion — check for preview URL
    if (!buildStream.isStreaming && buildStream.status === "succeeded") {
      setRightTab("preview");
    }
  }, [buildStream.events.length, buildStream.isStreaming, buildStream.status, addFileToTree]);

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
                      onContentChange={updateFileContent}
                    />
                  </Panel>
                </PanelGroup>
              )}

              {rightTab === "preview" && (
                <PreviewPane url={previewUrl} files={fileTree} />
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

/** Helper: recursively add a file to the proper directory in the tree */
function addToDirectory(
  nodes: FileNode[],
  parts: string[],
  depth: number,
  content: string,
  language: string
): FileNode[] {
  if (depth === parts.length - 1) {
    // We're at the file level — add it
    const fileName = parts[depth];
    return [
      ...nodes,
      {
        name: fileName,
        path: parts.join("/"),
        type: "file" as const,
        content,
        language,
      },
    ];
  }

  // We're at a directory level
  const dirName = parts[depth];
  const dirPath = parts.slice(0, depth + 1).join("/");
  const existingDir = nodes.find((n) => n.type === "directory" && n.name === dirName);

  if (existingDir) {
    return nodes.map((n) => {
      if (n.type === "directory" && n.name === dirName) {
        return {
          ...n,
          children: addToDirectory(n.children ?? [], parts, depth + 1, content, language),
        };
      }
      return n;
    });
  }

  // Create the directory
  return [
    ...nodes,
    {
      name: dirName,
      path: dirPath,
      type: "directory" as const,
      children: addToDirectory([], parts, depth + 1, content, language),
    },
  ];
}
