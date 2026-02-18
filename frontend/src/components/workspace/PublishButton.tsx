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
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildDeployDocument } from "@/components/preview/PreviewPane";
import type { FileNode, Project } from "@/types";
import * as api from "@/lib/api";

type PublishState =
  | "idle"
  | "configure"
  | "preflight"
  | "generating"
  | "uploading"
  | "deploying"
  | "polling"
  | "success"
  | "error";

type SubdomainStatus = "idle" | "checking" | "available" | "taken" | "invalid";

const POLL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

interface PublishButtonProps {
  project: Project | null;
  tenantId: string;
  fileTree: FileNode[];
  token: string;
  onPublished?: (url: string) => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

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
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preflightStatus, setPreflightStatus] = useState<api.PublishHealth | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  // Subdomain selection state
  const [subdomain, setSubdomain] = useState("");
  const [subdomainStatus, setSubdomainStatus] = useState<SubdomainStatus>("idle");
  const [subdomainMessage, setSubdomainMessage] = useState("");
  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
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
      setState("polling");
      pollStartRef.current = Date.now();

      pollRef.current = setInterval(async () => {
        if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
          stopPolling();
          setState("error");
          setError(
            "Deploy is taking longer than expected. Check Netlify dashboard for status.",
          );
          return;
        }

        try {
          const res = await fetch(
            `/api/publish-status?deploy_id=${encodeURIComponent(deployId)}`
          );
          if (!res.ok) throw new Error("Status check failed");
          const status = await res.json();

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
        } catch (err) {
          const elapsed = Date.now() - pollStartRef.current;
          if (elapsed > POLL_TIMEOUT_MS) {
            stopPolling();
            setState("error");
            setError(err instanceof Error ? err.message : "Polling failed");
          }
        }
      }, 2500);
    },
    [stopPolling, onPublished],
  );

  // Check subdomain availability
  const checkSubdomain = useCallback(async (value: string) => {
    if (!value || value.length < 1) {
      setSubdomainStatus("idle");
      setSubdomainMessage("");
      return;
    }

    // Client-side validation
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) && !/^[a-z0-9]$/.test(value)) {
      setSubdomainStatus("invalid");
      setSubdomainMessage("Use lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen.");
      return;
    }

    setSubdomainStatus("checking");
    setSubdomainMessage("");

    try {
      const res = await fetch(`/api/check-subdomain?subdomain=${encodeURIComponent(value)}`);
      if (!res.ok) throw new Error("Check failed");
      const data = await res.json();

      if (data.available) {
        setSubdomainStatus("available");
        setSubdomainMessage(`${value}.vedaa.io is available!`);
      } else {
        setSubdomainStatus("taken");
        setSubdomainMessage(data.reason || `${value}.vedaa.io is already taken.`);
      }
    } catch {
      setSubdomainStatus("idle");
      setSubdomainMessage("Could not check availability. You can still try to publish.");
    }
  }, []);

  // Debounced subdomain check on input change
  const handleSubdomainChange = useCallback((value: string) => {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setSubdomain(cleaned);
    setSubdomainStatus("idle");
    setSubdomainMessage("");

    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
    }

    if (cleaned.length >= 2) {
      checkTimeoutRef.current = setTimeout(() => {
        checkSubdomain(cleaned);
      }, 500);
    }
  }, [checkSubdomain]);

  // Open the publish modal (configure step)
  const openPublishModal = useCallback(() => {
    setError(null);
    setWarning(null);
    setShowModal(true);
    setState("configure");
    setSubdomainStatus("idle");
    setSubdomainMessage("");

    // Pre-populate subdomain from existing custom_domain or project name
    if (project?.custom_domain) {
      const existing = project.custom_domain.replace(/\.vedaa\.io$/, "");
      setSubdomain(existing);
    } else if (project?.name) {
      setSubdomain(slugify(project.name));
    } else {
      setSubdomain("");
    }
  }, [project]);

  // Execute the actual publish
  const handlePublish = useCallback(async () => {
    if (!project || !token || !tenantId) return;
    if (!subdomain || subdomain.length < 1) {
      setSubdomainStatus("invalid");
      setSubdomainMessage("Please enter a subdomain.");
      return;
    }

    setError(null);
    setWarning(null);

    try {
      // Step 1: Generate deployment HTML
      setState("generating");
      await new Promise((r) => setTimeout(r, 300));

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
        tenantId,
        project.id,
      );

      // Step 2: Upload to Netlify via our API route
      setState("uploading");
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          html,
          projectId: project.id,
          projectSlug: project.slug,
          projectName: project.name,
          tenantId,
          customSubdomain: subdomain,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || err.detail || `Publish failed (${res.status})`);
      }

      const result = await res.json();

      // Step 3: Check result
      if (result.status === "ready") {
        setState("success");
        const url = result.custom_domain
          ? `https://${result.custom_domain}`
          : result.url;
        setDeployedUrl(url);
        onPublished?.(url);
      } else {
        setState("deploying");
        pollStatus(result.deploy_id);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Publish failed";
      setState("error");
      setError(message);
    }
  }, [project, token, tenantId, fileTree, onPublished, pollStatus, subdomain]);

  const handleCopy = useCallback(() => {
    if (deployedUrl) {
      navigator.clipboard.writeText(deployedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [deployedUrl]);

  const closeModal = useCallback(() => {
    setShowModal(false);
    if (state === "success" || state === "error" || state === "configure") {
      setState("idle");
    }
  }, [state]);

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

  const canPublish =
    subdomain.length >= 1 &&
    subdomainStatus !== "taken" &&
    subdomainStatus !== "invalid" &&
    subdomainStatus !== "checking";

  return (
    <>
      {/* Main button */}
      {deployedUrl && state === "idle" ? (
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
            onClick={openPublishModal}
            disabled={!hasCode || isPublishing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium hover:bg-brand-500/20 transition-all disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            Republish
          </button>
        </div>
      ) : (
        <button
          onClick={openPublishModal}
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

      {/* Modal overlay */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeModal}
          />

          {/* Modal card */}
          <div className="relative w-full max-w-md mx-4 rounded-2xl bg-surface-1 border border-surface-3 shadow-2xl shadow-black/50 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-surface-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
                  <Rocket className="w-4 h-4 text-brand-400" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    {state === "configure" ? "Publish App" : "Deploying"}
                  </h2>
                  <p className="text-2xs text-slate-500">
                    {state === "configure"
                      ? "Choose your subdomain on vedaa.io"
                      : "Your app is going live"}
                  </p>
                </div>
              </div>
              <button
                onClick={closeModal}
                className="p-1.5 rounded-lg text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="px-5 py-5">
              {/* Configure step — subdomain selection */}
              {state === "configure" && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-2">
                      Subdomain
                    </label>
                    <div className="flex items-center gap-0">
                      <div className="relative flex-1">
                        <input
                          type="text"
                          value={subdomain}
                          onChange={(e) => handleSubdomainChange(e.target.value)}
                          placeholder="my-awesome-app"
                          className={cn(
                            "w-full px-3 py-2.5 rounded-l-lg bg-surface-2 border text-sm text-foreground placeholder:text-slate-600 focus:outline-none focus:ring-2 transition-all font-mono",
                            subdomainStatus === "available"
                              ? "border-emerald-500/30 focus:ring-emerald-500/20"
                              : subdomainStatus === "taken" || subdomainStatus === "invalid"
                                ? "border-red-500/30 focus:ring-red-500/20"
                                : "border-surface-3 focus:ring-brand-500/20",
                          )}
                          autoFocus
                        />
                        {subdomainStatus === "checking" && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
                          </div>
                        )}
                        {subdomainStatus === "available" && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          </div>
                        )}
                        {(subdomainStatus === "taken" || subdomainStatus === "invalid") && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                          </div>
                        )}
                      </div>
                      <div className="px-3 py-2.5 rounded-r-lg bg-surface-3 border border-l-0 border-surface-3 text-sm text-slate-400 font-mono whitespace-nowrap">
                        .vedaa.io
                      </div>
                    </div>

                    {/* Status message */}
                    {subdomainMessage && (
                      <p
                        className={cn(
                          "mt-2 text-xs flex items-center gap-1.5",
                          subdomainStatus === "available"
                            ? "text-emerald-400"
                            : subdomainStatus === "taken" || subdomainStatus === "invalid"
                              ? "text-red-400"
                              : "text-slate-500",
                        )}
                      >
                        {subdomainStatus === "available" && <CheckCircle2 className="w-3 h-3 shrink-0" />}
                        {(subdomainStatus === "taken" || subdomainStatus === "invalid") && <AlertCircle className="w-3 h-3 shrink-0" />}
                        {subdomainMessage}
                      </p>
                    )}

                    {/* Check button for manual check */}
                    {subdomain.length >= 2 && subdomainStatus === "idle" && (
                      <button
                        onClick={() => checkSubdomain(subdomain)}
                        className="mt-2 flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300 transition-all"
                      >
                        <Search className="w-3 h-3" />
                        Check availability
                      </button>
                    )}
                  </div>

                  {/* Preview URL */}
                  {subdomain && (
                    <div className="p-3 rounded-lg bg-surface-2/50 border border-surface-3">
                      <p className="text-2xs text-slate-500 mb-1">Your app will be live at:</p>
                      <p className="text-sm font-mono text-foreground">
                        https://<span className="text-brand-400">{subdomain}</span>.vedaa.io
                      </p>
                    </div>
                  )}

                  {/* Publish button */}
                  <button
                    onClick={handlePublish}
                    disabled={!canPublish}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all",
                      canPublish
                        ? "bg-brand-500 text-white hover:bg-brand-600 shadow-lg shadow-brand-500/25"
                        : "bg-surface-3 text-slate-600 cursor-not-allowed",
                    )}
                  >
                    <Rocket className="w-4 h-4" />
                    Publish to vedaa.io
                  </button>
                </div>
              )}

              {/* Progress steps */}
              {isPublishing && (
                <div className="space-y-3">
                  {/* Show chosen subdomain */}
                  <div className="p-2.5 rounded-lg bg-brand-500/5 border border-brand-500/20 mb-4">
                    <p className="text-xs text-slate-400">
                      Publishing to{" "}
                      <span className="font-mono text-brand-400 font-medium">
                        {subdomain}.vedaa.io
                      </span>
                    </p>
                  </div>

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

                  {subdomain && (
                    <div className="text-xs text-emerald-400 bg-emerald-500/10 rounded-lg p-2.5 border border-emerald-500/20">
                      Live at:{" "}
                      <span className="font-mono font-semibold">
                        {subdomain}.vedaa.io
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
                      className="p-1 rounded text-slate-500 hover:text-foreground transition-all shrink-0"
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
                    onClick={() => setState("configure")}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-all"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Try Again
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
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
          status === "active" && "text-foreground",
          status === "pending" && "text-slate-600",
        )}
      >
        {label}
      </span>
    </div>
  );
}
