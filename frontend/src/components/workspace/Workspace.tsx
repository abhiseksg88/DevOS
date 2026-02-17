"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useProject } from "@/hooks/useProject";
import { useGenerate, type PipelineEvent } from "@/hooks/useGenerate";
import { useAutoFix } from "@/hooks/useAutoFix";
import { useCodePersistence } from "@/hooks/useCodePersistence";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { FileTree } from "@/components/editor/FileTree";
import { PreviewPane } from "@/components/preview/PreviewPane";
import { BuildLog } from "@/components/build/BuildLog";
import { InfrastructurePanel } from "@/components/infrastructure/InfrastructurePanel";
import type { ChatMessage, FileNode, BuildEvent } from "@/types";
import {
  Zap,
  ArrowLeft,
  Code2,
  Eye,
  Terminal,
  Database,
  History,
  Loader2,
  Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { PublishButton } from "@/components/workspace/PublishButton";
import { IntegrationsPanel } from "@/components/workspace/IntegrationsPanel";
import { NeuralNexusPanel } from "@/components/workspace/NeuralNexusPanel";
import { VersionHistory } from "@/components/workspace/VersionHistory";

type RightTab = "code" | "preview" | "console" | "infra" | "history";

// Default file tree for new projects
const defaultFileTree: FileNode[] = [
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
            content: '// Your generated code will appear here\nexport default function Home() {\n  return (\n    <main className="min-h-screen flex items-center justify-center">\n      <h1>Welcome to Vedaa.io</h1>\n    </main>\n  );\n}',
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
];

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
  const { project, loading, userId, tenantId: resolvedTenantId, token } = useProject(projectId);
  const generator = useGenerate();
  const persistence = useCodePersistence(projectId, userId);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [activeFile, setActiveFile] = useState<FileNode | null>(null);
  const [openFiles, setOpenFiles] = useState<FileNode[]>([]);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [generationEvents, setGenerationEvents] = useState<BuildEvent[]>([]);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showNexus, setShowNexus] = useState(false);
  const [integrationContext, setIntegrationContext] = useState<string>("");
  const [nexusContext, setNexusContext] = useState<string>("");

  // Load integration context (what APIs are available) for code generation
  useEffect(() => {
    if (!token || !resolvedTenantId || !projectId) return;
    api.integrations
      .context(token, resolvedTenantId, projectId)
      .then((ctx) => setIntegrationContext(ctx.context))
      .catch(() => setIntegrationContext(""));
  }, [token, resolvedTenantId, projectId]);

  // Load Neural Nexus context (persona + project state + business logic) for code generation
  useEffect(() => {
    if (!token || !resolvedTenantId || !projectId) return;
    api.nexus
      .getContext(token, resolvedTenantId, projectId)
      .then((ctx) => setNexusContext(ctx.context))
      .catch(() => setNexusContext(""));
  }, [token, resolvedTenantId, projectId]);

  // File tree — updated from Claude output or editor changes
  const [fileTree, setFileTree] = useState<FileNode[]>(defaultFileTree);

  // Sync deployed URL from project when loaded
  useEffect(() => {
    if (project?.deployed_url) {
      setDeployedUrl(project.deployed_url);
    }
  }, [project?.deployed_url]);
  const seqRef = useRef(0);

  // Track pipeline events we've already converted to build events
  const pipelineSeenRef = useRef(0);

  // Ref to track last prompt for saving with generation
  const lastPromptRef = useRef<string>("");

  // -------------------------------------------------------------------------
  // Auto-fix loop: preview errors → fix agent → apply → re-render
  // -------------------------------------------------------------------------
  const autoFix = useAutoFix(
    fileTree,
    // onFileFix — apply the fixed file
    useCallback((path: string, content: string) => {
      setFileTree((prev) => updateInTree(prev, path, content));
      seqRef.current += 1;
      setGenerationEvents((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "patch",
          agent: "fix-agent",
          payload: { message: `Auto-fixed ${path}` },
          seq: seqRef.current,
          created_at: new Date().toISOString(),
        },
      ]);
    }, []),
    // onFixStart
    useCallback(() => {
      seqRef.current += 1;
      setGenerationEvents((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "agent_start",
          agent: "fix-agent",
          payload: { message: "Auto-fixing preview errors..." },
          seq: seqRef.current,
          created_at: new Date().toISOString(),
        },
      ]);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Detected preview errors — auto-fixing...",
          timestamp: Date.now(),
          status: "coding",
        },
      ]);
    }, []),
    // onFixEnd
    useCallback((success: boolean, iteration: number) => {
      seqRef.current += 1;
      if (success) {
        setGenerationEvents((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            build_id: "",
            kind: "build_progress",
            agent: "fix-agent",
            payload: {
              message: `Auto-fix succeeded (iteration ${iteration})`,
              status: "succeeded",
            },
            seq: seqRef.current,
            created_at: new Date().toISOString(),
          },
        ]);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Auto-fix applied successfully. Check the preview.`,
            timestamp: Date.now(),
            status: "succeeded",
          },
        ]);
      } else if (iteration >= 3) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Auto-fix couldn't resolve all errors after ${iteration} attempts. You can describe the issue and I'll try a different approach.`,
            timestamp: Date.now(),
          },
        ]);
      }
    }, []),
  );

  // Callback for PreviewPane error reporting
  const handlePreviewError = useCallback(
    (msg: string) => {
      if (!generator.isGenerating && !autoFix.isFixing) {
        autoFix.reportError(msg);
      }
    },
    [generator.isGenerating, autoFix],
  );

  // Helper: Convert file tree to code map for persistence
  function treeToCodeMap(tree: FileNode[]): Record<string, string> {
    const map: Record<string, string> = {};
    function walk(nodes: FileNode[]) {
      for (const node of nodes) {
        if (node.type === "file" && node.content) {
          map[node.path] = node.content;
        }
        if (node.children) walk(node.children);
      }
    }
    walk(tree);
    return map;
  }

  // Helper: Convert code map to file tree for loading
  function codeMapToTree(map: Record<string, string>): FileNode[] {
    // Start with the skeleton
    const tree = JSON.parse(JSON.stringify(defaultFileTree));

    // Overlay saved files
    for (const [path, content] of Object.entries(map)) {
      const parts = path.split("/");
      addFileToTreeStatic(tree, parts, 0, content);
    }
    return tree;
  }

  // Static version of addToDirectory for loading from saved code
  function addFileToTreeStatic(
    tree: FileNode[],
    parts: string[],
    index: number,
    content: string
  ): void {
    if (index === parts.length) return;

    const part = parts[index];
    const isFile = index === parts.length - 1;
    let node = tree.find((n) => n.name === part);

    if (!node) {
      const ext = part.split(".").pop() ?? "";
      const langMap: Record<string, string> = {
        tsx: "typescriptreact",
        jsx: "javascriptreact",
        ts: "typescript",
        js: "javascript",
        css: "css",
        json: "json",
        html: "html",
      };
      node = {
        name: part,
        path: parts.slice(0, index + 1).join("/"),
        type: isFile ? "file" : "directory",
        language: isFile ? langMap[ext] ?? "plaintext" : undefined,
        content: isFile ? content : undefined,
        children: isFile ? undefined : [],
      };
      tree.push(node);
    }

    if (index < parts.length - 1 && node.children) {
      addFileToTreeStatic(node.children, parts, index + 1, content);
    } else if (isFile && node.type === "file") {
      node.content = content;
    }
  }

  // Ref to track current file tree state (avoid stale closures in save operations)
  const fileTreeRef = useRef<FileNode[]>(fileTree);

  // Track last saved file count to prevent duplicate saves
  const lastSavedCountRef = useRef<number>(0);

  // Sync ref with state
  useEffect(() => {
    fileTreeRef.current = fileTree;
  }, [fileTree]);

  // Hydrate state from persistence on load
  useEffect(() => {
    if (persistence.isLoading) return;

    // Load code from persistence
    if (Object.keys(persistence.codeFiles).length > 0) {
      const tree = codeMapToTree(persistence.codeFiles);
      setFileTree(tree);
    }

    // Load messages from persistence
    if (persistence.messages.length > 0) {
      setMessages(persistence.messages);
    }

    // Load workspace state (active file, open tabs, right tab)
    if (persistence.workspaceState) {
      const ws = persistence.workspaceState;
      setRightTab(ws.rightTab as RightTab);
      if (ws.openFiles.length > 0) {
        const flat = flattenTree(fileTree);
        const restored = ws.openFiles
          .map((path) => flat.find((f) => f.path === path))
          .filter(Boolean) as FileNode[];
        setOpenFiles(restored);
        if (ws.activeFile) {
          const active = restored.find((f) => f.path === ws.activeFile);
          setActiveFile(active ?? null);
        }
      }
    }
  }, [persistence.isLoading]);

  /** Update a file's content in the tree */
  const updateFileContent = useCallback((path: string, content: string) => {
    setFileTree((prev) => updateInTree(prev, path, content));
    setActiveFile((prev) => (prev?.path === path ? { ...prev, content } : prev));
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));

    // Auto-save with debounce (handled in persistence hook)
    persistence.saveCode(treeToCodeMap(updateInTree(fileTree, path, content)), 'autosave');
  }, [persistence, fileTree]);

  /** Add or update a file in the tree */
  const addFileToTree = useCallback((path: string, content: string, language?: string) => {
    // Normalize path: strip leading ./ and /
    let normalizedPath = path.replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
    console.log('[Workspace] addFileToTree called:', { path: normalizedPath, contentLength: content.length });

    const parts = normalizedPath.split("/");
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
      const exists = flat.some((f) => f.path === normalizedPath);
      console.log('[Workspace] Updating file tree:', { path: normalizedPath, exists, prevTreeSize: flat.length });

      if (exists) {
        const updated = updateInTree(prev, normalizedPath, content);
        console.log('[Workspace] Updated existing file in tree');
        return updated;
      }
      const newTree = addToDirectory(prev, parts, 0, content, detectedLang);
      console.log('[Workspace] Added new file to tree');
      return newTree;
    });

    // Add a build event for the console
    seqRef.current += 1;
    setGenerationEvents((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        build_id: "",
        kind: "patch",
        agent: "sonnet",
        payload: { message: `Generated ${normalizedPath}` },
        seq: seqRef.current,
        created_at: new Date().toISOString(),
      },
    ]);
  }, []);

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

  // Sync pipeline events from the swarm into the build log
  useEffect(() => {
    const events = generator.pipelineEvents;
    if (events.length <= pipelineSeenRef.current) return;

    const newEvents = events.slice(pipelineSeenRef.current);
    pipelineSeenRef.current = events.length;

    const agentMap: Record<string, string> = {
      analyzer: "deepseek",
      coder: "sonnet",
      reviewer: "haiku",
      fixer: "sonnet",
    };

    const kindMap: Record<string, string> = {
      running: "agent_start",
      completed: "agent_end",
      failed: "error",
      skipped: "warning",
    };

    const converted: BuildEvent[] = newEvents.map((pe: PipelineEvent) => {
      seqRef.current += 1;
      const costStr = pe.meta?.cost_usd
        ? ` ($${pe.meta.cost_usd.toFixed(4)})`
        : "";
      const latencyStr = pe.meta?.latency_ms
        ? ` (${(pe.meta.latency_ms / 1000).toFixed(1)}s)`
        : "";
      const detailStr = pe.detail ? `\n   ${pe.detail}` : "";

      return {
        id: pe.id,
        build_id: "",
        kind: kindMap[pe.status] || "log",
        agent: agentMap[pe.agent] || pe.agent,
        payload: {
          message: `${pe.message}${latencyStr}${costStr}${detailStr}`,
        },
        seq: seqRef.current,
        created_at: new Date().toISOString(),
      };
    });

    setGenerationEvents((prev) => [...prev, ...converted]);
  }, [generator.pipelineEvents]);

  // When generation completes, switch to preview and save code
  useEffect(() => {
    if (!generator.isGenerating && generator.files.length > 0 && generator.files.length !== lastSavedCountRef.current) {
      console.log('[Workspace] Generation completed, saving code...', { fileCount: generator.files.length });
      setRightTab("preview");

      // Add completion event
      seqRef.current += 1;
      setGenerationEvents((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "build_progress",
          agent: null,
          payload: { message: `Build complete — ${generator.files.length} files generated`, status: "succeeded" },
          seq: seqRef.current,
          created_at: new Date().toISOString(),
        },
      ]);

      // Save code after generation completes using ref (not stale closure)
      const currentTree = fileTreeRef.current;
      const codeMap = treeToCodeMap(currentTree);
      console.log('[Workspace] Saving file tree:', { treeSize: flattenTree(currentTree).length, codeMapSize: Object.keys(codeMap).length });

      persistence.saveCode(codeMap, 'generation', lastPromptRef.current);
      lastSavedCountRef.current = generator.files.length;
    }
  }, [generator.isGenerating, generator.files.length, persistence]);

  const handleSendMessage = useCallback(
    async (content: string) => {
      // Reset auto-fix counter on new user prompt
      autoFix.reset();

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Save user message to persistence
      persistence.saveMessage('user', content);

      // Store prompt for saving with generation
      lastPromptRef.current = content;

      // Reset events and pipeline tracking
      seqRef.current = 0;
      pipelineSeenRef.current = 0;
      lastSavedCountRef.current = 0; // Reset save guard for new generation
      setGenerationEvents([
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "agent_start",
          agent: null,
          payload: { message: "Starting AI pipeline — Analyze → Code → Review..." },
          seq: 1,
          created_at: new Date().toISOString(),
        },
      ]);
      seqRef.current = 1;

      // Show "generating" message
      const generatingMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Running AI pipeline: Analyzer (DeepSeek) → Coder (Claude Sonnet) → Reviewer (Claude Haiku)...",
        timestamp: Date.now(),
        status: "coding",
      };
      setMessages((prev) => [...prev, generatingMsg]);
      persistence.saveMessage('assistant', generatingMsg.content);

      // Switch to console to show progress
      setRightTab("console");

      // Build conversation history for iterative chat (previous user+assistant turns)
      const history = messages
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status === "succeeded"))
        .map((m) => ({ role: m.role, content: m.content }));

      // Call Claude with full conversation history
      const result = await generator.generate(content, fileTree, (path, fileContent) => {
        addFileToTree(path, fileContent);
      }, history.length > 1 ? history.slice(0, -1) : undefined);

      // Use the returned result (not stale closure state)
      if (result.error) {
        const errorMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Error: ${result.error}`,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
        persistence.saveMessage('assistant', errorMsg.content);
      } else {
        const successMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Done! Generated ${result.files.length} file${result.files.length !== 1 ? "s" : ""}. Check the **Preview** tab to see your app, or the **Code** tab to inspect the files.`,
          timestamp: Date.now(),
          status: "succeeded",
        };
        setMessages((prev) => [...prev, successMsg]);
        persistence.saveMessage('assistant', successMsg.content);

        // Auto-switch to preview
        if (result.files.length > 0) {
          setRightTab("preview");
        }
      }
    },
    [generator, fileTree, addFileToTree, persistence, autoFix, integrationContext, nexusContext]
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
          {generator.isGenerating && (() => {
            const activeEvent = [...generator.pipelineEvents].reverse().find(
              (e) => e.status === "running"
            );
            const stageLabel = activeEvent
              ? { analyzer: "Analyzing", coder: "Coding", reviewer: "Reviewing", fixer: "Fixing" }[activeEvent.agent] || "Generating"
              : "Generating";
            const stageStyles: Record<string, string> = {
              analyzer: "bg-amber-500/10 border-amber-500/20 text-amber-400",
              coder: "bg-blue-500/10 border-blue-500/20 text-blue-400",
              reviewer: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
              fixer: "bg-violet-500/10 border-violet-500/20 text-violet-400",
            };
            const dotStyles: Record<string, string> = {
              analyzer: "bg-amber-400",
              coder: "bg-blue-400",
              reviewer: "bg-emerald-400",
              fixer: "bg-violet-400",
            };
            const agent = activeEvent?.agent || "";
            const badgeClass = stageStyles[agent] || "bg-amber-500/10 border-amber-500/20 text-amber-400";
            const dotClass = dotStyles[agent] || "bg-amber-400";
            return (
              <div className={cn("flex items-center gap-1.5 ml-3 px-2.5 py-1 rounded-full border", badgeClass)}>
                <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse-dot", dotClass)} />
                <span className="text-2xs font-medium uppercase tracking-wider">
                  {stageLabel}
                </span>
              </div>
            );
          })()}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNexus(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 text-xs font-medium hover:text-white hover:border-purple-500/30 transition-all"
          >
            <Brain className="w-3 h-3" />
            Neural Nexus
          </button>
          <button
            onClick={() => setShowIntegrations(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 text-xs font-medium hover:text-white hover:border-brand-500/30 transition-all"
          >
            <Zap className="w-3 h-3" />
            Integrations
          </button>
          <PublishButton
            project={project}
            tenantId={resolvedTenantId}
            fileTree={fileTree}
            token={token}
            onPublished={(url) => setDeployedUrl(url)}
          />
        </div>
      </header>

      {/* Main workspace — 3 panels */}
      <PanelGroup direction="horizontal" className="flex-1">
        {/* Panel 1: Chat */}
        <Panel defaultSize={30} minSize={20} maxSize={45}>
          <ChatPanel
            messages={messages}
            onSendMessage={handleSendMessage}
            isStreaming={generator.isGenerating}
            buildEvents={generationEvents}
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
                  { key: "infra", icon: Database, label: "Infra" },
                  { key: "history", icon: History, label: "History" },
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
                  {key === "console" && generator.isGenerating && (
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
                <PreviewPane
                  url={deployedUrl}
                  files={fileTree}
                  isGenerating={generator.isGenerating}
                  onError={(errorMsg) => {
                    // Auto-suggest fix if not already generating
                    if (!generator.isGenerating && errorMsg) {
                      const fixMsg: ChatMessage = {
                        id: crypto.randomUUID(),
                        role: "system",
                        content: `Preview error detected: "${errorMsg}". Click "Fix Error" below or send a new prompt to fix it.`,
                        timestamp: Date.now(),
                      };
                      setMessages((prev) => {
                        // Avoid duplicate error messages
                        if (prev.some((m) => m.content === fixMsg.content)) return prev;
                        return [...prev, fixMsg];
                      });
                    }
                  }}
                />
              )}

              {rightTab === "console" && (
                <BuildLog
                  events={generationEvents}
                  isStreaming={generator.isGenerating}
                  status={
                    generator.isGenerating
                      ? (() => {
                          const active = [...generator.pipelineEvents].reverse().find(
                            (e) => e.status === "running"
                          );
                          if (active?.agent === "analyzer") return "planning" as const;
                          if (active?.agent === "reviewer") return "reviewing" as const;
                          return "coding" as const;
                        })()
                      : generator.files.length > 0
                      ? "succeeded"
                      : null
                  }
                />
              )}

              {rightTab === "infra" && (
                <InfrastructurePanel
                  projectId={projectId}
                  tenantId={resolvedTenantId}
                />
              )}

              {rightTab === "history" && (
                <VersionHistory
                  projectId={projectId}
                  onRestore={(codeFiles) => {
                    const tree = codeMapToTree(codeFiles);
                    setFileTree(tree);
                    setRightTab("code");
                  }}
                />
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>

      {/* Integrations drawer */}
      <IntegrationsPanel
        projectId={projectId}
        tenantId={resolvedTenantId}
        token={token}
        open={showIntegrations}
        onClose={() => {
          setShowIntegrations(false);
          // Refresh integration context after panel closes (user may have added/updated)
          if (token && resolvedTenantId && projectId) {
            api.integrations
              .context(token, resolvedTenantId, projectId)
              .then((ctx) => setIntegrationContext(ctx.context))
              .catch(() => {});
          }
        }}
      />

      {/* Neural Nexus drawer */}
      <NeuralNexusPanel
        projectId={projectId}
        tenantId={resolvedTenantId}
        token={token}
        open={showNexus}
        onClose={() => {
          setShowNexus(false);
          // Refresh Nexus context after panel closes (state may have updated)
          if (token && resolvedTenantId && projectId) {
            api.nexus
              .getContext(token, resolvedTenantId, projectId)
              .then((ctx) => setNexusContext(ctx.context))
              .catch(() => {});
          }
        }}
      />
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
