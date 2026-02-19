"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useProject } from "@/hooks/useProject";
import { useGenerate } from "@/hooks/useGenerate"; 
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
  PanelLeft,
  PanelLeftClose,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { PublishButton } from "@/components/workspace/PublishButton";
import { IntegrationsPanel } from "@/components/workspace/IntegrationsPanel";
import { NeuralNexusPanel } from "@/components/workspace/NeuralNexusPanel";
import { useTheme } from "@/components/ThemeProvider";
import { PlanCard } from "@/components/chat/PlanCard";
import { AgentPipeline } from "@/components/chat/AgentPipeline";
import { ActivityTimeline } from "@/components/build/ActivityTimeline";
import { useWorkspaceMode } from "@/hooks/useWorkspaceMode";

type RightTab = "preview" | "cloud" | "console";

const defaultFileTree: FileNode[] = [
  {
    name: "src", path: "src", type: "directory",
    children: [
      {
        name: "app", path: "src/app", type: "directory",
        children: [
          { name: "page.tsx", path: "src/app/page.tsx", type: "file", language: "typescriptreact", content: '// Your generated code will appear here\nexport default function Home() {\n  return (\n    <main className="min-h-screen flex items-center justify-center">\n      <h1>Welcome to Vedaa.io</h1>\n    </main>\n  );\n}' },
          { name: "layout.tsx", path: "src/app/layout.tsx", type: "file", language: "typescriptreact", content: 'import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}' },
          { name: "globals.css", path: "src/app/globals.css", type: "file", language: "css", content: "@tailwind base;\n@tailwind components;\n@tailwind utilities;" },
        ],
      },
    ],
  },
  { name: "package.json", path: "package.json", type: "file", language: "json", content: '{\n  "name": "my-app",\n  "version": "0.1.0",\n  "dependencies": {\n    "next": "14.2.0",\n    "react": "^18.3.0"\n  }\n}' },
];

function flattenTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.content) result.push(node);
    if (node.children) result.push(...flattenTree(node.children));
  }
  return result;
}

function updateInTree(nodes: FileNode[], path: string, content: string): FileNode[] {
  return nodes.map((node) => {
    if (node.type === "file" && node.path === path) return { ...node, content };
    if (node.children) return { ...node, children: updateInTree(node.children, path, content) };
    return node;
  });
}

export function Workspace({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const { project, loading, userId, tenantId: resolvedTenantId, token } = useProject(projectId);
  
  // 1. Initialize our shiny new Python-connected Generator
  const generator = useGenerate({
    onFileGenerated: (path, content) => addFileToTree(path, content),
    onError: (err) => setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "system", content: `Error: ${err}`, timestamp: Date.now() }])
  });
  
  const persistence = useCodePersistence(projectId, userId);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>("preview");
  const [activeFile, setActiveFile] = useState<FileNode | null>(null);
  const [openFiles, setOpenFiles] = useState<FileNode[]>([]);
  const [deployedUrl, setDeployedUrl] = useState<string | null>(null);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [showNexus, setShowNexus] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [fileSidebarOpen, setFileSidebarOpen] = useState(false);
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [chatValue, setChatValue] = useState("");
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>(defaultFileTree);

  useEffect(() => {
    if (project?.deployed_url) setDeployedUrl(project.deployed_url);
  }, [project?.deployed_url]);

  const lastPromptRef = useRef<string>("");

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, generator.streamedText]);

  // -------------------------------------------------------------------------
  // REACTIVE UI STATE: Maps Pipeline Phase to Chat UI
  // -------------------------------------------------------------------------
  useEffect(() => {
     if (generator.pipelinePhase === 'analyzing') {
        setMessages(prev => {
           if (prev[prev.length - 1]?.status === 'planning') return prev;
           return [...prev, { id: "planning-msg", role: "assistant", content: "Analyzing requirements...", status: "planning", timestamp: Date.now() }];
        });
     }
     
     if (generator.pipelinePhase === 'awaiting_approval' && generator.currentPrd) {
        setMessages(prev => {
           const filtered = prev.filter(m => m.id !== "planning-msg");
           if (filtered.some(m => m.type === 'plan' && m.planStatus === 'pending')) return prev;
           return [...filtered, { id: "plan-card", role: "assistant", type: "plan", content: "Here is the build plan:", prd: generator.currentPrd!, planStatus: "pending", timestamp: Date.now() }];
        });
     }

     if (generator.pipelinePhase === 'scaffolding' || generator.pipelinePhase === 'building') {
        setMessages(prev => {
           const updated = prev.map(m => m.type === 'plan' ? { ...m, planStatus: 'completed' } : m);
           if (updated.some(m => m.id === "building-msg")) return updated;
           return [...updated, { id: "building-msg", role: "assistant", content: generator.streamedText || "Building...", status: "coding", timestamp: Date.now() }];
        });
        setRightTab("console");
     }

     if (generator.pipelinePhase === 'done') {
        setMessages(prev => {
           const filtered = prev.filter(m => m.id !== "building-msg");
           return [...filtered, { id: crypto.randomUUID(), role: "assistant", type: "summary", content: `Build complete. Generated ${generator.files.length} files.`, timestamp: Date.now(), status: "succeeded" }];
        });
        setRightTab("preview");
     }
  }, [generator.pipelinePhase, generator.currentPrd, generator.files.length]);

  const autoFix = useAutoFix(
    fileTree,
    useCallback((path: string, content: string) => setFileTree((prev) => updateInTree(prev, path, content)), []),
    useCallback(() => { /* start */ }, []),
    useCallback((success) => { /* end */ }),
  );

  const hasPreviewContent = fileTree !== defaultFileTree && flattenTree(fileTree).length > 3;
  
  const { mode, autoTab, statusLabel, statusColor } = useWorkspaceMode(
    { isGenerating: generator.isGenerating, isAnalyzing: generator.pipelinePhase === 'analyzing', pipelineEvents: generator.pipelineEvents || [] } as any, 
    autoFix, undefined, hasPreviewContent, generator.pipelinePhase === 'awaiting_approval',
  );

  const autoTabAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoTab && autoTab !== rightTab && autoTabAppliedRef.current !== autoTab) {
      autoTabAppliedRef.current = autoTab;
      setRightTab(autoTab as RightTab);
    }
  }, [autoTab]);

  function codeMapToTree(map: Record<string, string>): FileNode[] {
    const tree = JSON.parse(JSON.stringify(defaultFileTree));
    for (const [path, content] of Object.entries(map)) {
      const parts = path.split("/");
      addFileToTreeStatic(tree, parts, 0, content);
    }
    return tree;
  }

  function addFileToTreeStatic(tree: FileNode[], parts: string[], index: number, content: string) {
    if (index === parts.length) return;
    const part = parts[index];
    const isFile = index === parts.length - 1;
    let node = tree.find((n) => n.name === part);
    if (!node) {
       node = { name: part, path: parts.slice(0, index + 1).join("/"), type: isFile ? "file" : "directory", language: isFile ? "typescript" : undefined, content: isFile ? content : undefined, children: isFile ? undefined : [] };
      tree.push(node);
    }
    if (index < parts.length - 1 && node.children) {
      addFileToTreeStatic(node.children, parts, index + 1, content);
    } else if (isFile && node.type === "file") {
      node.content = content;
    }
  }

  useEffect(() => {
    if (persistence.isLoading) return;
    if (Object.keys(persistence.codeFiles).length > 0) setFileTree(codeMapToTree(persistence.codeFiles));
    if (persistence.messages.length > 0) setMessages(persistence.messages);
  }, [persistence.isLoading]);

  const updateFileContent = useCallback((path: string, content: string) => {
    setFileTree((prev) => updateInTree(prev, path, content));
    setActiveFile((prev) => (prev?.path === path ? { ...prev, content } : prev));
  }, []);

  const addFileToTree = useCallback((path: string, content: string) => {
    let normalizedPath = path.replace(/^\.\/+/, "").replace(/^\/+/, "").trim();
    const parts = normalizedPath.split("/");
    setFileTree((prev) => {
        const next = [...prev];
        addFileToTreeStatic(next, parts, 0, content);
        return next;
    });
  }, []);

  const handleFileSelect = useCallback((file: FileNode) => {
    if (file.type !== "file") return;
    setActiveFile(file);
    if (!openFiles.some(f => f.path === file.path)) setOpenFiles(prev => [...prev, file]);
    setCodeEditorOpen(true);
  }, [openFiles]);

  const handleCloseFile = useCallback((path: string) => {
      setOpenFiles((prev) => prev.filter((f) => f.path !== path));
      if (activeFile?.path === path) setActiveFile(null);
  }, [activeFile]);

  // ---------------------------------------------------------------
  // NEW GENERATION HANDLERS
  // ---------------------------------------------------------------
  
  const handleSendMessage = useCallback(async (content: string) => {
      if (!token || !resolvedTenantId || !projectId) return;
      lastPromptRef.current = content;
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() }]);
      persistence.saveMessage("user", content);
      
      // Calls Python Backend
      await generator.startBuild(token, resolvedTenantId, projectId, content);
  }, [token, resolvedTenantId, projectId, generator, persistence]);

  const handleApprovePlan = useCallback(async () => {
    if (!token || !resolvedTenantId || !projectId || !generator.buildId) return;
    setMessages(prev => prev.map(m => m.type === 'plan' ? { ...m, planStatus: 'building' } : m));
    
    // Calls Python Backend to continue
    await generator.approvePlan(token, resolvedTenantId, projectId, generator.buildId);
  }, [token, resolvedTenantId, projectId, generator]);

  const handleModifyPlan = useCallback(async (notes: string) => {
    if (!token || !resolvedTenantId || !projectId || !generator.buildId) return;
    await generator.approvePlan(token, resolvedTenantId, projectId, generator.buildId, { notes: notes });
  }, [token, resolvedTenantId, projectId, generator]);

  const handleRejectPlan = useCallback(() => {
    generator.stop();
    setMessages(prev => prev.map(m => m.type === 'plan' ? { ...m, planStatus: 'cancelled' } : m));
  }, [generator]);

  function handleChatSubmit() {
    const trimmed = chatValue.trim();
    if (!trimmed || generator.isGenerating) return;
    setChatValue("");
    handleSendMessage(trimmed);
  }

  if (loading) return <div className="h-screen flex items-center justify-center bg-surface-0"><Loader2 className="w-6 h-6 animate-spin text-brand-500" /></div>;

  const tabs = [
    { key: "preview" as const, icon: Eye, label: "Preview" },
    { key: "cloud" as const, icon: Cloud, label: "Cloud" },
    { key: "console" as const, icon: Terminal, label: "Console" },
  ];

  return (
    <div className="h-screen flex flex-col bg-surface-0">
      <header className="h-12 border-b border-surface-3/50 flex items-center justify-between px-4 shrink-0 bg-surface-0/80 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/dashboard")} className="p-1.5 rounded-lg text-slate-400 hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
          <span className="font-bold text-foreground">{project?.name ?? "Project"}</span>
          {generator.isGenerating && (
             <div className="flex items-center gap-1.5 ml-3 px-2.5 py-1 rounded-full border bg-blue-500/10 border-blue-500/20 text-blue-400">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse-dot" />
                <span className="text-2xs font-medium uppercase">{generator.pipelinePhase}</span>
             </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowNexus(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-2 text-xs font-medium text-slate-400"><Brain className="w-3 h-3" /> Neural Nexus</button>
          <button onClick={() => setShowIntegrations(true)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-2 text-xs font-medium text-slate-400"><Zap className="w-3 h-3" /> Integrations</button>
          <button onClick={toggleTheme} className="p-2 text-slate-400">{theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
          <PublishButton project={project} tenantId={resolvedTenantId} fileTree={fileTree} token={token} onPublished={setDeployedUrl} />
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {!chatCollapsed ? (
           <div className="w-[380px] shrink-0 border-r border-surface-3 flex flex-col bg-surface-1">
              <div className="flex-1 overflow-y-auto p-4 space-y-3" ref={chatScrollRef}>
                 {messages.length === 0 && (
                    <div className="text-center py-12 text-slate-500"><Sparkles className="w-8 h-8 mx-auto mb-3 text-brand-400" /><p>What do you want to build?</p></div>
                 )}
                 {messages.map(m => (
                    <div key={m.id}>
                       {m.role === 'user' ? (
                          <div className="flex justify-end"><div className="bg-brand-500/10 border-brand-500/20 px-3 py-2 rounded-xl text-sm">{m.content}</div></div>
                       ) : (
                          m.type === 'plan' ? (
                             <PlanCard prd={m.prd!} status={m.planStatus || 'pending'} onApprove={handleApprovePlan} onModify={handleModifyPlan} onReject={handleRejectPlan} disabled={generator.isGenerating && generator.pipelinePhase !== 'awaiting_approval'} />
                          ) : (
                             <div className="flex justify-start"><div className="bg-surface-2 px-3 py-2 rounded-xl text-sm text-slate-300">{m.content}</div></div>
                          )
                       )}
                    </div>
                 ))}
              </div>
              <div className="p-3 border-t border-surface-3">
                 <div className="flex items-center gap-2 bg-surface-2 rounded-xl border border-surface-3 px-3 py-2">
                    <textarea ref={chatTextareaRef} value={chatValue} onChange={(e) => setChatValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleChatSubmit()} placeholder={generator.isGenerating ? "Building..." : "Describe your app..."} disabled={generator.isGenerating} className="flex-1 bg-transparent resize-none outline-none text-sm h-10 py-2" />
                    <button onClick={handleChatSubmit} disabled={!chatValue || generator.isGenerating}><Send className="w-4 h-4 text-slate-400" /></button>
                 </div>
              </div>
           </div>
        ) : (
           <div className="w-10 border-r border-surface-3 pt-2 flex justify-center"><button onClick={() => setChatCollapsed(false)}><PanelLeft className="w-4 h-4 text-slate-500" /></button></div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
           <div className="h-10 border-b border-surface-3 flex items-center justify-between px-2">
              <div className="flex gap-1">
                 <button onClick={() => setFileSidebarOpen(!fileSidebarOpen)} className={cn("p-1.5 rounded", fileSidebarOpen ? "bg-brand-500/10 text-brand-400" : "text-slate-500")}><Code2 className="w-4 h-4" /></button>
                 {tabs.map(t => (
                    <button key={t.key} onClick={() => setRightTab(t.key)} className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded", rightTab === t.key ? "bg-surface-3 text-foreground" : "text-slate-500")}><t.icon className="w-3.5 h-3.5" /> {t.label}</button>
                 ))}
              </div>
           </div>

           <div className="flex-1 flex overflow-hidden">
              {fileSidebarOpen && (
                 <div className="w-[200px] border-r border-surface-3 overflow-y-auto bg-surface-1">
                    <FileTree files={fileTree} activeFile={activeFile} onSelect={handleFileSelect} />
                 </div>
              )}
              {codeEditorOpen && activeFile && (
                 <div className="w-1/2 border-r border-surface-3">
                    <CodeEditor file={activeFile} openFiles={openFiles} onSelectFile={setActiveFile} onCloseFile={handleCloseFile} onContentChange={updateFileContent} />
                 </div>
              )}
              <div className="flex-1 bg-surface-0 overflow-hidden relative">
                 {rightTab === 'preview' && <PreviewPane url={deployedUrl} files={fileTree} isGenerating={generator.isGenerating} isFixing={autoFix.isFixing} fixIteration={autoFix.iteration} tenantId={resolvedTenantId} projectId={projectId} userToken={token} onError={() => {}} />}
                 {rightTab === 'console' && <BuildLog events={generator.pipelineEvents.map((e, i) => ({ id: String(i), build_id: generator.buildId || "", kind: e.kind || "log", agent: e.agent, payload: { message: e.payload?.message || "Processing..." }, seq: i, created_at: new Date().toISOString() }))} isStreaming={generator.isGenerating} status={generator.error ? 'failed' : 'succeeded'} />}
                 {rightTab === 'cloud' && <InfrastructurePanel projectId={projectId} tenantId={resolvedTenantId} />}
              </div>
           </div>
        </div>
      </div>

      <IntegrationsPanel projectId={projectId} tenantId={resolvedTenantId} token={token} open={showIntegrations} onClose={() => setShowIntegrations(false)} />
      <NeuralNexusPanel projectId={projectId} tenantId={resolvedTenantId} token={token} open={showNexus} onClose={() => setShowNexus(false)} />
    </div>
  );
}
