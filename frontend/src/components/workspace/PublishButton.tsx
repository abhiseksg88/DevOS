"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Rocket,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  RefreshCw,
  X,
  Globe,
  Upload,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildDeployDocument } from "@/components/preview/PreviewPane";
import * as api from "@/lib/api";
import type { FileNode, Project } from "@/types";

type PublishState =
  | "idle"
  | "generating"
  | "uploading"
  | "deploying"
  | "polling"
  | "success"
  | "error";

interface PublishButtonProps {
  project: Project | null;
  tenantId: string;
  fileTree: FileNode[];
  token: string;
  onPublished?: (url: string) => void;
}

const STEP_LABELS: Record<PublishState, string> = {
  idle: "",
  generating: "Generating deployment...",
  uploading: "Uploading to Netlify...",
  deploying: "Deploying...",
  polling: "Almost ready...",
  success: "Published!",
  error: "Failed",
};

export function PublishButton({
  project,
  tenantId,
  fileTree,
  token,
  onPublished,
}: PublishButtonProps) {
  const [state, setState] = useState<PublishState>("idle");
  const [deployedUrl, setDeployedUrl] = useState<string | null>(
    project?.deployed_url ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryCountRef = useRef(0);

  // Sync deployed URL from project
  useEffect(() => {
    if (project?.deployed_url) {
      setDeployedUrl(project.deployed_url);
    }
  }, [project?.deployed_url]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(
    (deployId: string) => {
      if (!project) return;
      setState("polling");

      pollRef.current = setInterval(async () => {
        try {
          const status = await api.publish.status(
            token,
            tenantId,
            project.id,
            deployId,
          );

          if (status.state === "ready") {
            stopPolling();
            setState("success");
            setDeployedUrl(status.url);
            onPublished?.(status.url);
          } else if (status.state === "error" || status.state === "failed") {
            stopPolling();
            setState("error");
            setError("Deployment failed on Netlify");
          }
          // Otherwise keep polling (preparing, uploading, uploaded)
        } catch (err) {
          stopPolling();
          setState("error");
          setError(err instanceof Error ? err.message : "Polling failed");
        }
      }, 2000);
    },
    [project, token, tenantId, stopPolling, onPublished],
  );

  const handlePublish = useCallback(async () => {
    if (!project || !token || !tenantId) return;

    setError(null);
    setShowPanel(true);
    retryCountRef.current = 0;

    const doPublish = async (): Promise<void> => {
      try {
        // Step 1: Generate deployment HTML
        setState("generating");
        await new Promise((r) => setTimeout(r, 300)); // Brief visual feedback

        // Fetch Supabase credentials for embedding
        let supabaseUrl = "";
        let supabaseAnonKey = "";
        try {
          const response = await fetch("/api/preview-credentials");
          if (response.ok) {
            const creds = await response.json();
            supabaseUrl = creds.url || "";
            supabaseAnonKey = creds.anonKey || "";
          }
        } catch {
          // Continue without Supabase credentials
        }

        const html = buildDeployDocument(
          fileTree,
          supabaseUrl,
          supabaseAnonKey,
          project.name,
        );

        // Step 2: Upload to backend
        setState("uploading");
        const result = await api.publish.deploy(
          token,
          tenantId,
          project.id,
          html,
        );

        // Step 3: Check result
        if (result.status === "ready") {
          setState("success");
          setDeployedUrl(result.url);
          onPublished?.(result.url);
        } else {
          // Still deploying — start polling
          setState("deploying");
          pollStatus(result.deploy_id);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Publish failed";

        // Auto-retry up to 3 times
        if (retryCountRef.current < 3) {
          retryCountRef.current += 1;
          setState("uploading");
          setError(`Retrying (${retryCountRef.current}/3)...`);
          await new Promise((r) =>
            setTimeout(r, 2000 * retryCountRef.current),
          );
          return doPublish();
        }

        setState("error");
        setError(message);
      }
    };

    await doPublish();
  }, [project, token, tenantId, fileTree, onPublished, pollStatus]);

  const handleCopy = useCallback(() => {
    if (deployedUrl) {
      navigator.clipboard.writeText(deployedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [deployedUrl]);

  const isPublishing =
    state === "generating" ||
    state === "uploading" ||
    state === "deploying" ||
    state === "polling";

  const hasCode =
    fileTree.length > 0 &&
    fileTree.some(
      (n) =>
        n.type === "file" ||
        (n.children && n.children.length > 0),
    );

  return (
    <div className="relative">
      {/* Main button */}
      {deployedUrl && state === "idle" ? (
        /* Already published — show URL badge + Republish */
        <div className="flex items-center gap-1.5">
          <a
            href={deployedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-all"
          >
            <Globe className="w-3 h-3" />
            Live
          </a>
          <button
            onClick={handlePublish}
            disabled={!hasCode || isPublishing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium hover:bg-brand-500/20 transition-all disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            Republish
          </button>
        </div>
      ) : (
        /* Not published yet — show Publish button */
        <button
          onClick={handlePublish}
          disabled={!hasCode || isPublishing}
          className={cn(
            "flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all",
            isPublishing
              ? "bg-brand-500/20 border border-brand-500/30 text-brand-300 cursor-wait"
              : "bg-brand-500 text-white hover:bg-brand-600 shadow-lg shadow-brand-500/25 hover:shadow-brand-500/40",
            !hasCode && "opacity-50 cursor-not-allowed",
          )}
        >
          {isPublishing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Rocket className="w-3.5 h-3.5" />
          )}
          {isPublishing ? "Publishing..." : "Publish"}
        </button>
      )}

      {/* Floating status panel */}
      {showPanel && (
        <div className="absolute top-full right-0 mt-2 w-80 rounded-xl bg-surface-1 border border-surface-3 shadow-2xl shadow-black/50 z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-3">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-brand-400" />
              <span className="text-sm font-medium text-white">
                Netlify Deploy
              </span>
            </div>
            <button
              onClick={() => {
                setShowPanel(false);
                if (state === "success" || state === "error") {
                  setState("idle");
                }
              }}
              className="p-1 rounded-md text-slate-500 hover:text-white hover:bg-surface-2 transition-all"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Content */}
          <div className="px-4 py-4">
            {/* Progress steps */}
            {isPublishing && (
              <div className="space-y-3">
                <PublishStep
                  icon={<Zap className="w-3.5 h-3.5" />}
                  label="Generate deployment"
                  status={
                    state === "generating"
                      ? "active"
                      : "done"
                  }
                />
                <PublishStep
                  icon={<Upload className="w-3.5 h-3.5" />}
                  label="Upload to Netlify"
                  status={
                    state === "uploading"
                      ? "active"
                      : state === "deploying" || state === "polling"
                        ? "done"
                        : "pending"
                  }
                />
                <PublishStep
                  icon={<Globe className="w-3.5 h-3.5" />}
                  label="Deploy to live URL"
                  status={
                    state === "deploying" || state === "polling"
                      ? "active"
                      : "pending"
                  }
                />

                {error && (
                  <p className="text-xs text-amber-400 mt-2">{error}</p>
                )}
              </div>
            )}

            {/* Success */}
            {state === "success" && deployedUrl && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-emerald-400">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="text-sm font-medium">
                    Published successfully!
                  </span>
                </div>

                {/* Show custom domain if available */}
                {project?.custom_domain && (
                  <div className="text-xs text-emerald-400 bg-emerald-500/10 rounded-lg p-2.5 border border-emerald-500/20">
                    🌐 Live at:{" "}
                    <span className="font-mono font-semibold">
                      {project.custom_domain}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-surface-2 border border-surface-3">
                  <Globe className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="text-xs text-slate-300 truncate flex-1 font-mono">
                    {deployedUrl}
                  </span>
                  <button
                    onClick={handleCopy}
                    className="p-1 rounded text-slate-500 hover:text-white transition-all shrink-0"
                    title="Copy URL"
                  >
                    {copied ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <div className="flex gap-2">
                  <a
                    href={deployedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-all"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Visit App
                  </a>
                  <button
                    onClick={handleCopy}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-surface-2 border border-surface-3 text-slate-300 text-xs font-medium hover:bg-surface-3 transition-all"
                  >
                    <Copy className="w-3 h-3" />
                    {copied ? "Copied!" : "Copy Link"}
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {state === "error" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-red-400">
                  <AlertCircle className="w-5 h-5" />
                  <span className="text-sm font-medium">
                    Deploy failed
                  </span>
                </div>
                {error && (
                  <p className="text-xs text-slate-400 bg-surface-2 rounded-lg p-3 border border-surface-3">
                    {error}
                  </p>
                )}
                <button
                  onClick={handlePublish}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-all"
                >
                  <RefreshCw className="w-3 h-3" />
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress step indicator
// ---------------------------------------------------------------------------

function PublishStep({
  icon,
  label,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  status: "pending" | "active" | "done";
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all",
          status === "done" && "bg-emerald-500/20 text-emerald-400",
          status === "active" && "bg-brand-500/20 text-brand-400",
          status === "pending" && "bg-surface-3 text-slate-600",
        )}
      >
        {status === "done" ? (
          <CheckCircle2 className="w-3.5 h-3.5" />
        ) : status === "active" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          icon
        )}
      </div>
      <span
        className={cn(
          "text-xs font-medium transition-all",
          status === "done" && "text-emerald-400",
          status === "active" && "text-white",
          status === "pending" && "text-slate-600",
        )}
      >
        {label}
      </span>
    </div>
  );
}
