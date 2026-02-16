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
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildDeployDocument } from "@/components/preview/PreviewPane";
import * as api from "@/lib/api";
import type { FileNode, Project } from "@/types";

type PublishState =
  | "idle"
  | "preflight"
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

/** Max time to poll for deploy status before timing out (ms) */
const POLL_TIMEOUT_MS = 120_000;
/** Max HTML size we'll upload (10 MB) */
const MAX_HTML_SIZE = 10 * 1024 * 1024;

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
  const [warning, setWarning] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preflightStatus, setPreflightStatus] = useState<api.PublishHealth | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);
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
      pollStartRef.current = Date.now();

      pollRef.current = setInterval(async () => {
        // Timeout guard — stop polling after POLL_TIMEOUT_MS
        if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
          stopPolling();
          setState("error");
          setError(
            "Deploy is taking longer than expected. Check Netlify dashboard for status.",
          );
          return;
        }

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
            setError("Deployment failed on Netlify. Try again or check the Netlify dashboard.");
          }
          // Otherwise keep polling (preparing, uploading, uploaded)
        } catch (err) {
          // Don't stop polling on transient network errors — only stop after timeout
          const elapsed = Date.now() - pollStartRef.current;
          if (elapsed > POLL_TIMEOUT_MS) {
            stopPolling();
            setState("error");
            setError(err instanceof Error ? err.message : "Polling failed");
          }
          // Otherwise silently retry on next interval
        }
      }, 2500);
    },
    [project, token, tenantId, stopPolling, onPublished],
  );

  const handlePublish = useCallback(async () => {
    if (!project || !token || !tenantId) return;

    setError(null);
    setWarning(null);
    setShowPanel(true);
    setPreflightStatus(null);
    retryCountRef.current = 0;

    // ─── Step 0: Pre-flight health check ───────────────────────────
    setState("preflight");
    const health = await api.publish.health(token);
    setPreflightStatus(health);

    if (!health.ready) {
      // Config error — don't retry, show clear message
      setState("error");
      if (!health.netlify_configured) {
        setError(
          "Netlify is not configured. Set NETLIFY_TOKEN in your backend environment variables.",
        );
      } else if (!health.netlify_reachable) {
        setError(
          health.netlify_error ||
            "Cannot reach Netlify API. Check your token is valid.",
        );
      } else {
        setError("Publish infrastructure is not ready. Check backend configuration.");
      }
      return;
    }

    if (!health.supabase_configured) {
      setWarning("Supabase credentials not configured — published app won't have database access.");
    }

    // ─── Step 1: Generate deployment HTML ──────────────────────────
    const doPublish = async (): Promise<void> => {
      try {
        setState("generating");
        await new Promise((r) => setTimeout(r, 200)); // Brief visual feedback

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
          // Continue without Supabase credentials — user was already warned
        }

        if (!supabaseUrl && !supabaseAnonKey && !warning) {
          setWarning("Supabase credentials unavailable — published app won't have database access.");
        }

        const html = buildDeployDocument(
          fileTree,
          supabaseUrl,
          supabaseAnonKey,
          project.name,
        );

        // ─── Validate generated HTML ─────────────────────────────
        if (!html || html.trim().length < 50) {
          setState("error");
          setError("Generated HTML is empty or too small. Add some code to your project first.");
          return;
        }

        if (html.length > MAX_HTML_SIZE) {
          setState("error");
          setError(
            `Generated HTML is too large (${(html.length / 1024 / 1024).toFixed(1)} MB). ` +
              "Reduce your code size and try again.",
          );
          return;
        }

        // ─── Step 2: Upload to backend ─────────────────────────────
        setState("uploading");
        const result = await api.publish.deploy(
          token,
          tenantId,
          project.id,
          html,
        );

        // ─── Step 3: Check result ──────────────────────────────────
        if (result.status === "ready") {
          setState("success");
          setDeployedUrl(result.url);
          onPublished?.(result.url);
        } else {
          // Still deploying — start polling with timeout guard
          setState("deploying");
          pollStatus(result.deploy_id);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Publish failed";

        // Don't retry on config/auth errors — only retry on transient failures
        const isRetryable =
          !message.includes("not configured") &&
          !message.includes("503") &&
          !message.includes("401") &&
          !message.includes("403") &&
          !message.includes("too large") &&
          !message.includes("empty");

        if (isRetryable && retryCountRef.current < 3) {
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
  }, [project, token, tenantId, fileTree, warning, onPublished, pollStatus]);

  const handleCopy = useCallback(() => {
    if (deployedUrl) {
      navigator.clipboard.writeText(deployedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [deployedUrl]);

  const isPublishing =
    state === "preflight" ||
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
                  icon={<ShieldCheck className="w-3.5 h-3.5" />}
                  label="Pre-flight check"
                  status={
                    state === "preflight"
                      ? "active"
                      : (["generating", "uploading", "deploying", "polling"] as string[]).includes(state)
                        ? "done"
                        : "pending"
                  }
                />
                <PublishStep
                  icon={<Zap className="w-3.5 h-3.5" />}
                  label="Generate deployment"
                  status={
                    state === "generating"
                      ? "active"
                      : (["uploading", "deploying", "polling"] as string[]).includes(state)
                        ? "done"
                        : "pending"
                  }
                />
                <PublishStep
                  icon={<Upload className="w-3.5 h-3.5" />}
                  label="Upload to Netlify"
                  status={
                    state === "uploading"
                      ? "active"
                      : (["deploying", "polling"] as string[]).includes(state)
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

                {warning && (
                  <p className="text-xs text-amber-400 mt-2 flex items-start gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {warning}
                  </p>
                )}

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
                    <Globe className="w-3 h-3 inline mr-1" />
                    Live at:{" "}
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

                {warning && (
                  <p className="text-xs text-amber-400 flex items-start gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {warning}
                  </p>
                )}

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

                {/* Pre-flight failure details */}
                {preflightStatus && !preflightStatus.ready && (
                  <div className="space-y-1.5 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                    <PreflightItem
                      ok={preflightStatus.netlify_configured}
                      label="Netlify token"
                    />
                    <PreflightItem
                      ok={preflightStatus.netlify_reachable}
                      label="Netlify API reachable"
                    />
                    <PreflightItem
                      ok={preflightStatus.supabase_configured}
                      label="Supabase credentials"
                    />
                    {preflightStatus.netlify_team && (
                      <p className="text-xs text-slate-500 mt-1">
                        Team: {preflightStatus.netlify_team}
                      </p>
                    )}
                  </div>
                )}

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
// Pre-flight check item
// ---------------------------------------------------------------------------

function PreflightItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <AlertCircle className="w-3.5 h-3.5 text-red-400" />
      )}
      <span className={ok ? "text-slate-400" : "text-red-400"}>{label}</span>
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
