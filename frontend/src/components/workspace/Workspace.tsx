"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useProject } from "@/hooks/useProject";
import { useGenerate, type PipelineEvent } from "@/hooks/useGenerate";
import { useAutoFix } from "@/hooks/useAutoFix";
import { useCodePersistence } from "@/hooks/useCodePersistence";
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
  Cloud,
  Loader2,
  Brain,
  Sun,
  Moon,
  Send,
  ChevronUp,
  ChevronDown,
  Sparkles,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { PublishButton } from "@/components/workspace/PublishButton";
import { IntegrationsPanel } from "@/components/workspace/IntegrationsPanel";
import { NeuralNexusPanel } from "@/components/workspace/NeuralNexusPanel";
import { VersionHistory } from "@/components/workspace/VersionHistory";
import { useTheme } from "@/components/ThemeProvider";
import { FigmaPanel } from "@/components/workspace/FigmaPanel";
import { PlanCard } from "@/components/chat/PlanCard";
import { AgentPipeline } from "@/components/chat/AgentPipeline";
import { ActivityTimeline } from "@/components/build/ActivityTimeline";
import { useWorkspaceMode } from "@/hooks/useWorkspaceMode";

type RightTab = "preview" | "cloud" | "console";

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
  const { theme, toggleTheme } = useTheme();
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
  const [consoleView, setConsoleView] = useState<"log" | "timeline">("timeline");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [fileSidebarOpen, setFileSidebarOpen] = useState(false);
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);

  // Chat input state
  const [chatValue, setChatValue] = useState("");
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

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

  // Refs for in-place message updates (fixes stuck "Coding" spinner)
  const generatingMsgIdRef = useRef<string | null>(null);
  const fixMsgIdRef = useRef<string | null>(null);

  // Ref to always access the latest handleSendMessage (avoids stale closure in useEffect)
  const handleSendMessageRef = useRef<(content: string) => void>(() => {});
  // Track whether the initial URL prompt has been processed (prevents double-fire in Strict Mode)
  const initialPromptProcessed = useRef(false);

  const updateMessageById = useCallback((id: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, ...updates } : msg));
  }, []);

  // Auto-scroll chat when new messages arrive
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Auto-resize chat textarea
  useEffect(() => {
    const el = chatTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [chatValue]);

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
          payload: { message: "Refining preview..." },
          seq: seqRef.current,
          created_at: new Date().toISOString(),
        },
      ]);
      if (fixMsgIdRef.current) {
        updateMessageById(fixMsgIdRef.current, {
          content: "Still refining...",
          status: "coding",
        });
      } else {
        const fixId = crypto.randomUUID();
        fixMsgIdRef.current = fixId;
        setMessages((prev) => [
          ...prev,
          {
            id: fixId,
            role: "assistant",
            content: "Refining your app for the best experience...",
            timestamp: Date.now(),
            status: "coding",
          },
        ]);
      }
    }, [updateMessageById]),
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
        if (fixMsgIdRef.current) {
          updateMessageById(fixMsgIdRef.current, {
            content: "Looking good! Verifying your app...",
            status: "succeeded",
          });
        }
      } else if (iteration >= 5) {
        if (fixMsgIdRef.current) {
          updateMessageById(fixMsgIdRef.current, {
            content: "I ran into a tricky issue. Could you describe what you'd like changed?",
            status: "failed",
          });
          fixMsgIdRef.current = null;
        }
      } else {
        if (fixMsgIdRef.current) {
          updateMessageById(fixMsgIdRef.current, {
            content: "Still refining...",
            status: "coding",
          });
        }
      }
    }, [updateMessageById]),
  );

  // Workspace mode — auto-derives from build/fix/deploy state
  const hasPreviewContent = fileTree !== defaultFileTree && flattenTree(fileTree).length > 3;
  const { mode, autoTab, statusLabel, statusColor } = useWorkspaceMode(
    generator,
    autoFix,
    undefined,
    hasPreviewContent,
  );

  // Auto-switch tabs when mode changes (user can still override manually)
  const autoTabAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoTab && autoTab !== rightTab && autoTabAppliedRef.current !== autoTab) {
      autoTabAppliedRef.current = autoTab;
      setRightTab(autoTab as RightTab);
    }
  }, [autoTab]);

  // Queue errors that arrive during generation — re-fire after generation completes
  const pendingErrorsRef = useRef<string[]>([]);

  const handlePreviewError = useCallback(
    (msg: string) => {
      if (!msg) return;
      if (!generator.isGenerating && !autoFix.isFixing) {
        autoFix.reportError(msg);
      } else {
        if (!pendingErrorsRef.current.includes(msg)) {
          pendingErrorsRef.current.push(msg);
        }
      }
    },
    [generator.isGenerating, autoFix],
  );

  // When generation finishes, flush any queued preview errors to auto-fix
  useEffect(() => {
    if (!generator.isGenerating && pendingErrorsRef.current.length > 0) {
      const queued = [...pendingErrorsRef.current];
      pendingErrorsRef.current = [];
      const timer = setTimeout(() => {
        for (const msg of queued) {
          autoFix.reportError(msg);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [generator.isGenerating, autoFix]);

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
    const tree = JSON.parse(JSON.stringify(defaultFileTree));
    for (const [path, content] of Object.entries(map)) {
      const parts = path.split("/");
      addFileToTreeStatic(tree, parts, 0, content);
    }
    return tree;
  }

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

  // Ref to track current file tree state
  const fileTreeRef = useRef<FileNode[]>(fileTree);
  const lastSavedCountRef = useRef<number>(0);

  useEffect(() => {
    fileTreeRef.current = fileTree;
  }, [fileTree]);

  // Hydrate state from persistence on load
  useEffect(() => {
    if (persistence.isLoading) return;

    if (Object.keys(persistence.codeFiles).length > 0) {
      const tree = codeMapToTree(persistence.codeFiles);
      setFileTree(tree);
    }

    if (persistence.messages.length > 0) {
      setMessages(persistence.messages);
    }

    if (persistence.workspaceState) {
      const ws = persistence.workspaceState;
      // Map old tab names to new ones
      const tabMap: Record<string, RightTab> = {
        preview: "preview",
        code: "preview",
        infra: "cloud",
        console: "console",
        history: "preview",
        design: "preview",
      };
      setRightTab(tabMap[ws.rightTab] ?? "preview");
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
    persistence.saveCode(treeToCodeMap(updateInTree(fileTree, path, content)), 'autosave');
  }, [persistence, fileTree]);

  /** Add or update a file in the tree */
  const addFileToTree = useCallback((path: string, content: string, language?: string) => {
    let normalizedPath = path.replace(/^\.\/+/, "").replace(/^\/+/, "").trim();

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
      if (exists) {
        return updateInTree(prev, normalizedPath, content);
      }
      return addToDirectory(prev, parts, 0, content, detectedLang);
    });

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
    setCodeEditorOpen(true);
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

  // Helper to map PipelineEvents to ChatPipelineStages
  const mapPipelineToStages = useCallback((): import("@/types").ChatPipelineStage[] => {
    const stageKeys = ["plan", "code", "review", "fix"];
    const stageLabels: Record<string, string> = { plan: "Plan", code: "Code", review: "Review", fix: "Fix" };
    const agentForStage: Record<string, string> = { plan: "DeepSeek", code: "Sonnet", review: "Haiku", fix: "Sonnet" };
    const pipelineAgentMap: Record<string, string> = { analyzer: "plan", coder: "code", reviewer: "review", fixer: "fix" };

    return stageKeys.map((key) => {
      const matchingEvent = generator.pipelineEvents.find(
        (e) => pipelineAgentMap[e.agent] === key
      );
      let status: "pending" | "active" | "done" | "error" | "skipped" = "pending";
      if (matchingEvent) {
        if (matchingEvent.status === "running") status = "active";
        else if (matchingEvent.status === "completed") status = "done";
        else if (matchingEvent.status === "failed") status = "error";
        else if (matchingEvent.status === "skipped") status = "skipped";
      }
      return {
        key,
        label: stageLabels[key],
        agent: agentForStage[key],
        status,
        meta: matchingEvent?.meta ? { latency_ms: matchingEvent.meta.latency_ms, cost_usd: matchingEvent.meta.cost_usd } : undefined,
      };
    });
  }, [generator.pipelineEvents]);

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

  // Sync chat message status badge with pipeline stages in real-time
  useEffect(() => {
    if (!generator.isGenerating || !generatingMsgIdRef.current) return;

    const activeEvent = [...generator.pipelineEvents].reverse().find(
      (e) => e.status === "running"
    );
    if (!activeEvent) return;

    const stageMap: Record<string, { status: "planning" | "coding" | "reviewing"; content: string }> = {
      analyzer: { status: "planning", content: "Analyzing requirements..." },
      coder:    { status: "coding", content: "Generating code with Claude..." },
      reviewer: { status: "reviewing", content: "Reviewing code quality..." },
      fixer:    { status: "coding", content: "Applying review fixes..." },
    };

    const stage = stageMap[activeEvent.agent];
    if (stage) {
      updateMessageById(generatingMsgIdRef.current, {
        ...stage,
        pipelineStages: mapPipelineToStages(),
      });
    }
  }, [generator.pipelineEvents, generator.isGenerating, updateMessageById, mapPipelineToStages]);

  // When generation completes, switch to preview and save code
  useEffect(() => {
    if (!generator.isGenerating && generator.files.length > 0 && generator.files.length !== lastSavedCountRef.current) {
      setRightTab("preview");

      seqRef.current += 1;
      setGenerationEvents((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "agent_end",
          agent: null,
          payload: { message: `Build complete — ${generator.files.length} files generated`, status: "succeeded" },
          seq: seqRef.current,
          created_at: new Date().toISOString(),
        },
      ]);

      const currentTree = fileTreeRef.current;
      const codeMap = treeToCodeMap(currentTree);
      persistence.saveCode(codeMap, 'generation', lastPromptRef.current);
      lastSavedCountRef.current = generator.files.length;
    }
  }, [generator.isGenerating, generator.files.length, persistence]);

  // Find the latest pending plan message
  const pendingPlan = messages.find(
    (m) => m.type === "plan" && m.planStatus === "pending",
  );

  const isDisabled = generator.isGenerating || generator.isAnalyzing || !!pendingPlan;

  // ---------------------------------------------------------------
  // handleSendMessage — Phase 1: Analyze only, show PlanCard
  // ---------------------------------------------------------------
  const handleSendMessage = useCallback(
    async (content: string) => {
      autoFix.reset();
      fixMsgIdRef.current = null;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      persistence.saveMessage("user", content);
      lastPromptRef.current = content;

      seqRef.current = 0;
      pipelineSeenRef.current = 0;
      lastSavedCountRef.current = 0;
      setGenerationEvents([
        {
          id: crypto.randomUUID(),
          build_id: "",
          kind: "agent_start",
          agent: null,
          payload: { message: "Analyzing requirements..." },
          seq: 1,
          created_at: new Date().toISOString(),
        },
      ]);
      seqRef.current = 1;

      const planningMsgId = crypto.randomUUID();
      generatingMsgIdRef.current = planningMsgId;
      setMessages((prev) => [
        ...prev,
        {
          id: planningMsgId,
          role: "assistant",
          content: "Analyzing your request...",
          timestamp: Date.now(),
          status: "planning",
        },
      ]);

      const history = messages
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status === "succeeded"))
        .map((m) => ({ role: m.role, content: m.content }));

      const result = await generator.analyze(
        content,
        fileTree,
        history.length > 1 ? history.slice(0, -1) : undefined,
      );

      if (result.prd) {
        updateMessageById(planningMsgId, {
          type: "plan",
          content: "Here's the build plan:",
          prd: result.prd,
          planStatus: "pending",
          status: "succeeded",
        });
        generatingMsgIdRef.current = null;
      } else {
        // Analyzer unavailable — show degraded plan card, still require approval
        const fallbackPrd: Record<string, unknown> = {
          intent: "build",
          summary: content.slice(0, 200) + (content.length > 200 ? "..." : ""),
          changes: [],
          new_components: [],
          integration_notes: "Detailed analysis was unavailable. The build will proceed using your prompt directly.",
        };
        updateMessageById(planningMsgId, {
          type: "plan",
          content: "Ready to build — review and approve:",
          prd: fallbackPrd,
          planStatus: "pending",
          status: "succeeded",
        });
        generatingMsgIdRef.current = null;
      }
    },
    [generator, fileTree, persistence, autoFix, updateMessageById, messages],
  );

  // Keep ref in sync so the initial-prompt useEffect always calls the latest version
  handleSendMessageRef.current = handleSendMessage;

  // ---------------------------------------------------------------
  // handleApprovePlan — Phase 2: Build with the approved PRD
  // ---------------------------------------------------------------
  const handleApprovePlan = useCallback(async () => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.type === "plan" && m.planStatus === "pending");
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], planStatus: "building" };
      return updated;
    });

    const pipelineId = crypto.randomUUID();
    generatingMsgIdRef.current = pipelineId;
    setMessages((prev) => [
      ...prev,
      {
        id: pipelineId,
        role: "assistant",
        type: "pipeline",
        content: "Building...",
        timestamp: Date.now(),
        status: "coding",
        pipelineStages: mapPipelineToStages(),
      },
    ]);

    setRightTab("console");
    seqRef.current = 0;
    pipelineSeenRef.current = 0;
    lastSavedCountRef.current = 0;
    setGenerationEvents([
      {
        id: crypto.randomUUID(),
        build_id: "",
        kind: "agent_start",
        agent: null,
        payload: { message: "Starting build — Code → Review → Fix..." },
        seq: 1,
        created_at: new Date().toISOString(),
      },
    ]);
    seqRef.current = 1;

    const history = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.status === "succeeded"))
      .map((m) => ({ role: m.role, content: m.content }));

    const result = await generator.build(
      lastPromptRef.current,
      fileTree,
      (path, fileContent) => addFileToTree(path, fileContent),
      history.length > 1 ? history.slice(0, -1) : undefined,
      generator.currentPrd ?? undefined,
    );

    if (generatingMsgIdRef.current) {
      updateMessageById(generatingMsgIdRef.current, {
        status: result.error ? "failed" : "succeeded",
        pipelineStages: mapPipelineToStages(),
      });
      generatingMsgIdRef.current = null;
    }

    if (result.error) {
      persistence.saveMessage("assistant", `Error: ${result.error}`);
    } else if (result.files.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          type: "summary",
          content: `Generated ${result.files.length} files`,
          timestamp: Date.now(),
          status: "succeeded",
          buildFiles: result.files.map((f) => ({ path: f.path })),
          pipelineStages: mapPipelineToStages(),
        },
      ]);

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.type === "plan" && m.planStatus === "building");
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], planStatus: "completed" };
        return updated;
      });

      persistence.saveMessage("assistant", `Generated ${result.files.length} files`);
      setRightTab("preview");
    }
  }, [generator, fileTree, addFileToTree, persistence, updateMessageById, mapPipelineToStages, messages]);

  // ---------------------------------------------------------------
  // handleModifyPlan
  // ---------------------------------------------------------------
  const handleModifyPlan = useCallback(
    async (notes: string) => {
      const modifiedPrompt = `${lastPromptRef.current}\n\nAdditional requirements: ${notes}`;
      lastPromptRef.current = modifiedPrompt;

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.type === "plan" && m.planStatus === "pending");
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          content: "Re-analyzing with your modifications...",
          planStatus: "modified",
          status: "planning",
        };
        return updated;
      });

      const result = await generator.analyze(modifiedPrompt, fileTree);
      if (result.prd) {
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) => m.type === "plan" && (m.planStatus === "modified" || m.planStatus === "pending"),
          );
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            prd: result.prd!,
            planStatus: "pending",
            status: "succeeded",
          };
          return updated;
        });
      }
    },
    [generator, fileTree],
  );

  // ---------------------------------------------------------------
  // handleRejectPlan
  // ---------------------------------------------------------------
  const handleRejectPlan = useCallback(() => {
    generator.stop(); // Reset pipelinePhase to idle so mode exits "awaiting_approval"
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.type === "plan" && m.planStatus === "pending");
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], planStatus: "completed", status: "cancelled" };
      return updated;
    });
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "system",
        content: "Plan cancelled. Send a new prompt to try again.",
        timestamp: Date.now(),
      },
    ]);

    // Record rejection feedback to Nexus (learning loop)
    if (token && resolvedTenantId && projectId) {
      api.nexus
        .recordFeedback(token, resolvedTenantId, projectId, {
          event_type: "code_rejected",
          feedback: { reason: "Plan rejected by user", stage: "planning" },
          agent: "shadow_cto",
          prompt: lastPromptRef.current,
        })
        .catch(() => {});
    }
  }, [generator, token, resolvedTenantId, projectId]);

  function handleChatSubmit() {
    const trimmed = chatValue.trim();
    if (!trimmed || isDisabled) return;
    setChatValue("");
    handleSendMessage(trimmed).catch((err) => {
      console.error("[Workspace] handleSendMessage failed:", err);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `Something went wrong: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
          timestamp: Date.now(),
        },
      ]);
    });
  }

  // Handle initial prompt from URL params
  // Uses a ref to always call the latest handleSendMessage (avoids stale closure)
  // and a processed flag to prevent double-fire in React Strict Mode
  useEffect(() => {
    if (initialPromptProcessed.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("prompt");
    if (prompt && messages.length === 0 && !generator.isGenerating && !generator.isAnalyzing) {
      initialPromptProcessed.current = true;
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete("prompt");
      window.history.replaceState({}, "", url.toString());
      // Send the prompt via ref to avoid stale closure
      handleSendMessageRef.current(prompt);
    }
  }, [messages.length, generator.isGenerating, generator.isAnalyzing]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-0">
        <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
      </div>
    );
  }

  // Tab definitions for right panel (Code is accessed via file tree only)
  const tabs = [
    { key: "preview" as const, icon: Eye, label: "Preview" },
    { key: "cloud" as const, icon: Cloud, label: "Cloud" },
    { key: "console" as const, icon: Terminal, label: "Console" },
  ];

  return (
    <div className="h-screen flex flex-col bg-surface-0">
      {/* Top bar */}
      <header className="h-12 border-b border-surface-3/50 flex items-center justify-between px-4 shrink-0 bg-surface-0/80 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard")}
            className="p-1.5 rounded-lg text-slate-400 hover:text-foreground hover:bg-surface-2 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="w-px h-5 bg-surface-3" />
          <div className="flex items-center gap-2.5">
            <Image
              src="/vedaa-logo.svg"
              alt="Vedaa"
              width={24}
              height={24}
              className="rounded-md"
            />
            <span className="text-sm font-bold tracking-tight text-foreground">
              {project?.name ?? "Project"}
            </span>
          </div>
          {(generator.isGenerating || generator.isAnalyzing) && (() => {
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 text-xs font-medium hover:text-foreground hover:border-purple-500/30 transition-all"
          >
            <Brain className="w-3 h-3" />
            Neural Nexus
          </button>
          <button
            onClick={() => setShowIntegrations(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-surface-3 text-slate-400 text-xs font-medium hover:text-foreground hover:border-brand-500/30 transition-all"
          >
            <Zap className="w-3 h-3" />
            Integrations
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-slate-400 hover:text-foreground hover:bg-surface-2 border border-transparent hover:border-surface-3 transition-all"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
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

      {/* Main workspace — Chat left + Content right */}
      <div className="flex-1 flex overflow-hidden">
        {/* ============ LEFT: Chat Panel ============ */}
        {!chatCollapsed ? (
          <div className="w-[380px] shrink-0 border-r border-surface-3 flex flex-col bg-surface-1">
            {/* Chat header */}
            <div className="h-10 border-b border-surface-3 flex items-center justify-between px-4 shrink-0">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500">
                  AI Chat
                </span>
                {statusLabel && (
                  <div
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded-full border text-2xs font-medium",
                      statusColor,
                    )}
                  >
                    {(mode === "build" || mode === "plan" || mode === "awaiting_approval") && (
                      <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-dot" />
                    )}
                    {statusLabel}
                  </div>
                )}
              </div>
              <button
                onClick={() => setChatCollapsed(true)}
                className="p-1 rounded text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all"
                title="Collapse chat"
              >
                <PanelLeftClose className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Messages area */}
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-12 animate-fade-in">
                  <div className="w-14 h-14 rounded-2xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center mx-auto mb-5 glow-brand">
                    <Sparkles className="w-7 h-7 text-brand-400" />
                  </div>
                  <h2 className="text-lg font-semibold text-foreground mb-2">What do you want to build?</h2>
                  <p className="text-sm text-slate-500 max-w-xs mx-auto leading-relaxed mb-6">
                    Describe your app and AI agents will plan, code, review, and deploy it.
                  </p>
                  <div className="space-y-2">
                    {[
                      "A SaaS dashboard with auth and billing",
                      "A landing page with hero and features",
                      "A task management app with database",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setChatValue(suggestion)}
                        className="block w-full text-left text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded-lg bg-surface-2/50 border border-surface-3 hover:border-brand-500/30 hover:bg-surface-2 cursor-pointer transition-all"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages
                .filter((m) => m.role !== "system")
                .map((m) => (
                  <div key={m.id}>
                    {/* User message */}
                    {m.role === "user" && (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] px-3 py-2 rounded-xl bg-brand-500/10 border border-brand-500/20 text-sm text-foreground">
                          {m.content}
                        </div>
                      </div>
                    )}

                    {/* Assistant message */}
                    {m.role === "assistant" && m.type !== "plan" && m.type !== "pipeline" && (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] px-3 py-2 rounded-xl bg-surface-2 border border-surface-3 text-sm text-slate-300">
                          {m.status === "planning" || m.status === "coding" || m.status === "reviewing" ? (
                            <div className="flex items-center gap-2">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-400" />
                              <span>{m.content}</span>
                            </div>
                          ) : (
                            m.content
                          )}
                        </div>
                      </div>
                    )}

                    {/* Plan card — visible in all statuses (pending, building, completed) */}
                    {m.type === "plan" && m.prd && (
                      <div className={cn("animate-slide-up", m.planStatus === "completed" && "opacity-60")}>
                        <PlanCard
                          prd={m.prd}
                          status={m.planStatus || "pending"}
                          onApprove={handleApprovePlan}
                          onModify={handleModifyPlan}
                          onReject={handleRejectPlan}
                          disabled={isDisabled}
                        />
                      </div>
                    )}

                    {/* Pipeline visualization */}
                    {m.type === "pipeline" && m.pipelineStages && (
                      <div className="animate-slide-up">
                        <AgentPipeline stages={m.pipelineStages} compact />
                      </div>
                    )}

                    {/* Build summary */}
                    {m.type === "summary" && (
                      <div className="px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">
                        {m.content}
                        {m.buildFiles && (
                          <div className="mt-2 space-y-0.5">
                            {m.buildFiles.map((f: { path: string }) => (
                              <div key={f.path} className="text-2xs text-emerald-500/70 font-mono">
                                {f.path}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}

              {/* Pipeline dots during build */}
              {mapPipelineToStages().some((s) => s.status !== "pending") && mode === "build" && (
                <div className="animate-slide-up">
                  <AgentPipeline stages={mapPipelineToStages()} compact />
                </div>
              )}
            </div>

            {/* Chat input */}
            <div className="border-t border-surface-3 p-3">
              <div className="flex items-end gap-2 rounded-xl bg-surface-2 border border-surface-3 focus-within:border-brand-500/50 focus-within:ring-1 focus-within:ring-brand-500/30 transition-all">
                <textarea
                  ref={chatTextareaRef}
                  value={chatValue}
                  onChange={(e) => setChatValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleChatSubmit();
                    }
                  }}
                  placeholder={
                    isDisabled
                      ? pendingPlan
                        ? "Review the plan above to continue..."
                        : statusLabel ? `${statusLabel}...` : "Building..."
                      : "Describe what you want to build..."
                  }
                  disabled={isDisabled}
                  rows={1}
                  className="flex-1 bg-transparent text-foreground text-sm placeholder:text-slate-600 px-3 py-2.5 resize-none focus:outline-none disabled:opacity-50 max-h-[120px]"
                />
                <button
                  onClick={handleChatSubmit}
                  disabled={isDisabled || !chatValue.trim()}
                  className="p-2 m-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-all disabled:opacity-30 disabled:hover:bg-brand-600 shrink-0"
                >
                  {isDisabled ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Collapsed chat — thin strip to expand */
          <div className="w-10 shrink-0 border-r border-surface-3 flex flex-col items-center pt-2 bg-surface-1">
            <button
              onClick={() => setChatCollapsed(false)}
              className="p-2 rounded-lg text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all"
              title="Show chat"
            >
              <PanelLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* ============ RIGHT: Tabs + Content ============ */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <div className="h-10 border-b border-surface-3 flex items-center justify-between px-2 shrink-0">
            <div className="flex items-center gap-1">
              {/* File tree toggle */}
              <button
                onClick={() => {
                  setFileSidebarOpen(!fileSidebarOpen);
                  if (!fileSidebarOpen) setCodeEditorOpen(true);
                }}
                className={cn(
                  "p-1.5 rounded-lg transition-all mr-1",
                  fileSidebarOpen
                    ? "text-brand-400 bg-brand-500/10"
                    : "text-slate-500 hover:text-foreground hover:bg-surface-2"
                )}
                title={fileSidebarOpen ? "Hide files" : "Show files"}
              >
                <Code2 className="w-3.5 h-3.5" />
              </button>

              {tabs.map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => {
                    setRightTab(key);
                    if (key !== "preview") setCodeEditorOpen(false);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                    rightTab === key && !codeEditorOpen
                      ? "bg-surface-3 text-foreground"
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

            {/* Close code editor button when open */}
            {codeEditorOpen && (
              <button
                onClick={() => { setCodeEditorOpen(false); setFileSidebarOpen(false); }}
                className="px-2 py-1 rounded-lg text-2xs font-medium text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all"
              >
                Close Editor
              </button>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex">
            {/* File sidebar */}
            {fileSidebarOpen && (
              <div className="w-[200px] shrink-0 border-r border-surface-3 flex flex-col bg-surface-1 overflow-y-auto">
                <div className="p-2">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-slate-500 px-2">Files</span>
                </div>
                <FileTree
                  files={fileTree}
                  activeFile={activeFile}
                  onSelect={handleFileSelect}
                />
              </div>
            )}

            {/* Code editor split (when file is open) */}
            {codeEditorOpen && activeFile && (
              <div className={cn(
                "shrink-0 border-r border-surface-3 overflow-hidden",
                fileSidebarOpen ? "w-[calc(50%-100px)]" : "w-1/2"
              )}>
                <CodeEditor
                  file={activeFile}
                  openFiles={openFiles}
                  onSelectFile={(f) => setActiveFile(f)}
                  onCloseFile={handleCloseFile}
                  onContentChange={updateFileContent}
                />
              </div>
            )}

            <div className="flex-1 overflow-hidden">
              {rightTab === "preview" && (
                <PreviewPane
                  url={deployedUrl}
                  files={fileTree}
                  isGenerating={generator.isGenerating}
                  isFixing={autoFix.isFixing}
                  fixIteration={autoFix.iteration}
                  tenantId={resolvedTenantId}
                  projectId={projectId}
                  userToken={token}
                  onError={handlePreviewError}
                />
              )}

              {rightTab === "cloud" && (
                <InfrastructurePanel
                  projectId={projectId}
                  tenantId={resolvedTenantId}
                />
              )}

              {rightTab === "console" && (
                <div className="h-full flex flex-col">
                  <div className="flex items-center gap-1 px-3 py-1.5 border-b border-surface-3 shrink-0">
                    <button
                      onClick={() => setConsoleView("timeline")}
                      className={cn(
                        "px-2 py-1 rounded text-2xs font-medium transition-all",
                        consoleView === "timeline"
                          ? "bg-surface-3 text-foreground"
                          : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      Timeline
                    </button>
                    <button
                      onClick={() => setConsoleView("log")}
                      className={cn(
                        "px-2 py-1 rounded text-2xs font-medium transition-all",
                        consoleView === "log"
                          ? "bg-surface-3 text-foreground"
                          : "text-slate-500 hover:text-slate-300"
                      )}
                    >
                      Raw Log
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {consoleView === "timeline" ? (
                      <ActivityTimeline
                        events={generationEvents}
                        isStreaming={generator.isGenerating}
                      />
                    ) : (
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
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Integrations drawer */}
      <IntegrationsPanel
        projectId={projectId}
        tenantId={resolvedTenantId}
        token={token}
        open={showIntegrations}
        onClose={() => {
          setShowIntegrations(false);
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
