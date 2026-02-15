"use client";

import { useState, useCallback, useEffect } from "react";
import {
  X,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Zap,
  Shield,
  Eye,
  EyeOff,
  Trash2,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import type { Integration, IntegrationCategory, IntegrationTestResult } from "@/types";

// ---------------------------------------------------------------------------
// Available connector catalog — like Claude's MCP connectors
// ---------------------------------------------------------------------------

interface ConnectorDef {
  provider: string;
  category: IntegrationCategory;
  display_name: string;
  description: string;
  icon: string;       // Emoji for simplicity
  credentials: Array<{
    key: string;
    label: string;
    placeholder: string;
    secret: boolean;
  }>;
  config?: Array<{
    key: string;
    label: string;
    type: "text" | "select";
    options?: string[];
    default?: string;
  }>;
  docs_url?: string;
}

const CONNECTORS: ConnectorDef[] = [
  // --- LLM ---
  {
    provider: "openai",
    category: "llm",
    display_name: "OpenAI",
    description: "GPT-4o, GPT-4, GPT-3.5 — text generation, chat, embeddings",
    icon: "\u{1F916}",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "sk-...", secret: true },
    ],
    config: [
      {
        key: "model",
        label: "Default Model",
        type: "select",
        options: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
        default: "gpt-4o",
      },
    ],
    docs_url: "https://platform.openai.com/api-keys",
  },
  {
    provider: "anthropic",
    category: "llm",
    display_name: "Anthropic Claude",
    description: "Claude Sonnet, Haiku — reasoning, code, analysis",
    icon: "\u{1F9E0}",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "sk-ant-...", secret: true },
    ],
    docs_url: "https://console.anthropic.com/settings/keys",
  },
  {
    provider: "google_ai",
    category: "llm",
    display_name: "Google AI (Gemini)",
    description: "Gemini Pro, Flash — multimodal AI",
    icon: "\u2728",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "AIza...", secret: true },
    ],
    docs_url: "https://aistudio.google.com/apikey",
  },
  // --- Auth ---
  {
    provider: "supabase",
    category: "auth",
    display_name: "Supabase",
    description: "Auth, database, realtime, storage — all-in-one backend",
    icon: "\u26A1",
    credentials: [
      { key: "url", label: "Project URL", placeholder: "https://xxx.supabase.co", secret: false },
      { key: "anon_key", label: "Anon Key", placeholder: "eyJ...", secret: true },
    ],
    docs_url: "https://supabase.com/dashboard/project/_/settings/api",
  },
  {
    provider: "clerk",
    category: "auth",
    display_name: "Clerk",
    description: "Drop-in authentication with user management",
    icon: "\uD83D\uDD10",
    credentials: [
      { key: "publishable_key", label: "Publishable Key", placeholder: "pk_...", secret: false },
      { key: "secret_key", label: "Secret Key", placeholder: "sk_...", secret: true },
    ],
    docs_url: "https://dashboard.clerk.com",
  },
  {
    provider: "firebase",
    category: "auth",
    display_name: "Firebase",
    description: "Auth, Firestore, hosting, cloud functions",
    icon: "\uD83D\uDD25",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "AIza...", secret: true },
      { key: "project_id", label: "Project ID", placeholder: "my-app-12345", secret: false },
    ],
    config: [
      { key: "auth_domain", label: "Auth Domain", type: "text" },
    ],
    docs_url: "https://console.firebase.google.com",
  },
  // --- Payment ---
  {
    provider: "stripe",
    category: "payment",
    display_name: "Stripe",
    description: "Payments, subscriptions, invoices",
    icon: "\uD83D\uDCB3",
    credentials: [
      { key: "publishable_key", label: "Publishable Key", placeholder: "pk_...", secret: false },
      { key: "secret_key", label: "Secret Key", placeholder: "sk_...", secret: true },
    ],
    docs_url: "https://dashboard.stripe.com/apikeys",
  },
  // --- Email ---
  {
    provider: "resend",
    category: "email",
    display_name: "Resend",
    description: "Transactional email API",
    icon: "\u2709\uFE0F",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "re_...", secret: true },
    ],
    config: [
      { key: "from_email", label: "From Email", type: "text" },
    ],
    docs_url: "https://resend.com/api-keys",
  },
  {
    provider: "sendgrid",
    category: "email",
    display_name: "SendGrid",
    description: "Email delivery and marketing",
    icon: "\uD83D\uDCE7",
    credentials: [
      { key: "api_key", label: "API Key", placeholder: "SG...", secret: true },
    ],
    docs_url: "https://app.sendgrid.com/settings/api_keys",
  },
  // --- Storage ---
  {
    provider: "cloudinary",
    category: "storage",
    display_name: "Cloudinary",
    description: "Image and video management",
    icon: "\uD83C\uDF05",
    credentials: [
      { key: "cloud_name", label: "Cloud Name", placeholder: "my-cloud", secret: false },
      { key: "api_key", label: "API Key", placeholder: "123...", secret: true },
      { key: "api_secret", label: "API Secret", placeholder: "abc...", secret: true },
    ],
    docs_url: "https://console.cloudinary.com/settings/api-keys",
  },
  // --- Analytics ---
  {
    provider: "posthog",
    category: "analytics",
    display_name: "PostHog",
    description: "Product analytics and session replay",
    icon: "\uD83E\uDDA5",
    credentials: [
      { key: "api_key", label: "Project API Key", placeholder: "phc_...", secret: false },
    ],
    config: [
      { key: "host", label: "Host URL", type: "text", default: "https://app.posthog.com" },
    ],
    docs_url: "https://posthog.com/docs/getting-started",
  },
];

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  llm: "AI / LLM",
  auth: "Authentication",
  database: "Database",
  payment: "Payments",
  email: "Email",
  storage: "Storage",
  analytics: "Analytics",
  custom: "Custom",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IntegrationsPanelProps {
  projectId: string;
  tenantId: string;
  token: string;
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IntegrationsPanel({
  projectId,
  tenantId,
  token,
  open,
  onClose,
}: IntegrationsPanelProps) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCatalog, setShowCatalog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Load integrations
  useEffect(() => {
    if (!open || !token || !tenantId || !projectId) return;
    setLoading(true);
    api.integrations
      .list(token, tenantId, projectId)
      .then(setIntegrations)
      .catch(() => setIntegrations([]))
      .finally(() => setLoading(false));
  }, [open, token, tenantId, projectId]);

  // Add a connector
  const handleAdd = useCallback(
    async (connector: ConnectorDef) => {
      try {
        const result = await api.integrations.create(token, tenantId, projectId, {
          provider: connector.provider,
          category: connector.category,
          display_name: connector.display_name,
          credentials: {},
          config: connector.config
            ? Object.fromEntries(
                connector.config.map((c) => [c.key, c.default ?? ""]),
              )
            : {},
        });
        setIntegrations((prev) => [...prev, result]);
        setShowCatalog(false);
        setEditingId(result.id);
      } catch (err) {
        // If already exists, just close catalog
        if (err instanceof Error && err.message.includes("already exists")) {
          setShowCatalog(false);
        }
      }
    },
    [token, tenantId, projectId],
  );

  // Save credentials
  const handleSave = useCallback(
    async (integrationId: string, credentials: Record<string, string>, config: Record<string, unknown>) => {
      setSavingId(integrationId);
      try {
        const result = await api.integrations.update(
          token,
          tenantId,
          projectId,
          integrationId,
          { credentials, config },
        );
        setIntegrations((prev) =>
          prev.map((i) => (i.id === integrationId ? result : i)),
        );
        setEditingId(null);
      } catch {
        // Error handled by UI
      } finally {
        setSavingId(null);
      }
    },
    [token, tenantId, projectId],
  );

  // Test connection
  const handleTest = useCallback(
    async (integrationId: string) => {
      setTestingId(integrationId);
      setTestResult(null);
      try {
        const result = await api.integrations.test(
          token,
          tenantId,
          projectId,
          integrationId,
        );
        setTestResult(result);
        // Refresh the integration status
        const updated = await api.integrations.list(token, tenantId, projectId);
        setIntegrations(updated);
      } catch {
        setTestResult({ ok: false, message: "Test failed", latency_ms: null });
      } finally {
        setTestingId(null);
      }
    },
    [token, tenantId, projectId],
  );

  // Delete integration
  const handleDelete = useCallback(
    async (integrationId: string) => {
      await api.integrations.delete(token, tenantId, projectId, integrationId);
      setIntegrations((prev) => prev.filter((i) => i.id !== integrationId));
    },
    [token, tenantId, projectId],
  );

  if (!open) return null;

  const addedProviders = new Set(integrations.map((i) => i.provider));
  const availableConnectors = CONNECTORS.filter(
    (c) => !addedProviders.has(c.provider),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-surface-0 border-l border-surface-3 shadow-2xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
              <Zap className="w-4 h-4 text-brand-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Integrations</h2>
              <p className="text-xs text-slate-500">
                Connect APIs, LLMs, auth, payments
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-surface-2 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
            </div>
          ) : showCatalog ? (
            /* --- Connector Catalog --- */
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-white">
                  Add Connector
                </h3>
                <button
                  onClick={() => setShowCatalog(false)}
                  className="text-xs text-slate-500 hover:text-white transition-all"
                >
                  Back
                </button>
              </div>

              {Object.entries(
                availableConnectors.reduce<Record<string, ConnectorDef[]>>(
                  (acc, c) => {
                    const cat = c.category;
                    if (!acc[cat]) acc[cat] = [];
                    acc[cat].push(c);
                    return acc;
                  },
                  {},
                ),
              ).map(([category, connectors]) => (
                <div key={category}>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">
                    {CATEGORY_LABELS[category as IntegrationCategory] ?? category}
                  </p>
                  <div className="space-y-1.5">
                    {connectors.map((c) => (
                      <button
                        key={c.provider}
                        onClick={() => handleAdd(c)}
                        className="w-full flex items-center gap-3 p-3 rounded-xl bg-surface-1 border border-surface-3 hover:border-brand-500/30 hover:bg-surface-2 transition-all text-left"
                      >
                        <span className="text-lg">{c.icon}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white">
                            {c.display_name}
                          </p>
                          <p className="text-xs text-slate-500 truncate">
                            {c.description}
                          </p>
                        </div>
                        <Plus className="w-4 h-4 text-slate-500" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {availableConnectors.length === 0 && (
                <p className="text-sm text-slate-500 text-center py-8">
                  All available connectors have been added.
                </p>
              )}
            </div>
          ) : (
            /* --- Active Integrations --- */
            <div className="p-4 space-y-3">
              {integrations.length === 0 ? (
                <div className="text-center py-12 space-y-3">
                  <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mx-auto">
                    <Shield className="w-5 h-5 text-slate-600" />
                  </div>
                  <p className="text-sm text-slate-400">No integrations yet</p>
                  <p className="text-xs text-slate-600 max-w-[250px] mx-auto">
                    Add connectors for LLMs, auth, payments, and more. Your
                    generated apps will use them automatically.
                  </p>
                  <button
                    onClick={() => setShowCatalog(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Connector
                  </button>
                </div>
              ) : (
                <>
                  {integrations.map((integration) => {
                    const connector = CONNECTORS.find(
                      (c) => c.provider === integration.provider,
                    );
                    const isEditing = editingId === integration.id;
                    const isTesting = testingId === integration.id;

                    return (
                      <IntegrationCard
                        key={integration.id}
                        integration={integration}
                        connector={connector}
                        isEditing={isEditing}
                        isTesting={isTesting}
                        isSaving={savingId === integration.id}
                        testResult={
                          testingId === integration.id || testResult?.ok !== undefined
                            ? testResult
                            : null
                        }
                        onEdit={() =>
                          setEditingId(isEditing ? null : integration.id)
                        }
                        onSave={(creds, config) =>
                          handleSave(integration.id, creds, config)
                        }
                        onTest={() => handleTest(integration.id)}
                        onDelete={() => handleDelete(integration.id)}
                      />
                    );
                  })}

                  <button
                    onClick={() => setShowCatalog(true)}
                    className="w-full flex items-center justify-center gap-1.5 py-3 rounded-xl border border-dashed border-surface-3 text-slate-500 text-xs font-medium hover:border-brand-500/30 hover:text-brand-400 transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Connector
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration Card — shows a single connector with edit/test/delete
// ---------------------------------------------------------------------------

function IntegrationCard({
  integration,
  connector,
  isEditing,
  isTesting,
  isSaving,
  testResult,
  onEdit,
  onSave,
  onTest,
  onDelete,
}: {
  integration: Integration;
  connector: ConnectorDef | undefined;
  isEditing: boolean;
  isTesting: boolean;
  isSaving: boolean;
  testResult: IntegrationTestResult | null;
  onEdit: () => void;
  onSave: (creds: Record<string, string>, config: Record<string, unknown>) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const [credValues, setCredValues] = useState<Record<string, string>>({});
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  // Initialize form when editing starts
  useEffect(() => {
    if (isEditing && connector) {
      // Pre-fill with empty strings for all credential fields
      const creds: Record<string, string> = {};
      for (const c of connector.credentials) {
        creds[c.key] = "";
      }
      setCredValues(creds);

      // Pre-fill config from integration
      const cfg: Record<string, string> = {};
      for (const c of connector.config ?? []) {
        cfg[c.key] = String(integration.config?.[c.key] ?? c.default ?? "");
      }
      setConfigValues(cfg);
    }
  }, [isEditing, connector, integration.config]);

  const statusColor = {
    active: "text-emerald-400 bg-emerald-500/10",
    inactive: "text-slate-500 bg-surface-2",
    error: "text-red-400 bg-red-500/10",
  }[integration.status];

  return (
    <div
      className={cn(
        "rounded-xl border transition-all",
        isEditing
          ? "border-brand-500/30 bg-surface-1"
          : "border-surface-3 bg-surface-1 hover:border-surface-3/80",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3 p-3">
        <span className="text-lg shrink-0">{connector?.icon ?? "\u2699\uFE0F"}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-white truncate">
              {integration.display_name}
            </p>
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                statusColor,
              )}
            >
              {integration.status}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {CATEGORY_LABELS[integration.category] ?? integration.category}
            {integration.last_tested_at && integration.last_test_ok && (
              <span className="text-emerald-500 ml-1.5">
                <CheckCircle2 className="w-3 h-3 inline" /> tested
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className={cn(
              "p-1.5 rounded-lg text-xs transition-all",
              isEditing
                ? "bg-brand-500/10 text-brand-400"
                : "text-slate-500 hover:text-white hover:bg-surface-2",
            )}
            title="Edit"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
            title="Remove"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Credential hints (when not editing) */}
      {!isEditing && Object.keys(integration.credentials).length > 0 && (
        <div className="px-3 pb-3 flex flex-wrap gap-1.5">
          {Object.entries(integration.credentials).map(([key, hint]) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-2 text-[10px] font-mono text-slate-500"
            >
              {hint.name}: <span className="text-slate-400">{hint.hint}</span>
            </span>
          ))}
        </div>
      )}

      {/* Edit form */}
      {isEditing && connector && (
        <div className="px-3 pb-3 space-y-3 border-t border-surface-3 pt-3">
          {/* Credential fields */}
          {connector.credentials.map((cred) => {
            const isSecret = cred.secret;
            const shown = showSecrets[cred.key];
            const hint = integration.credentials[cred.key];

            return (
              <div key={cred.key}>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  {cred.label}
                  {hint?.is_set && (
                    <span className="text-emerald-500 ml-1.5 font-normal">
                      (currently set: {hint.hint})
                    </span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={isSecret && !shown ? "password" : "text"}
                    placeholder={hint?.is_set ? "Leave blank to keep current" : cred.placeholder}
                    value={credValues[cred.key] ?? ""}
                    onChange={(e) =>
                      setCredValues((prev) => ({
                        ...prev,
                        [cred.key]: e.target.value,
                      }))
                    }
                    className="w-full rounded-lg border border-surface-3 bg-surface-0 px-3 py-2 text-xs text-white font-mono placeholder:text-slate-600 focus:ring-1 focus:ring-brand-500 focus:border-transparent outline-none transition-all pr-8"
                  />
                  {isSecret && (
                    <button
                      type="button"
                      onClick={() =>
                        setShowSecrets((prev) => ({
                          ...prev,
                          [cred.key]: !prev[cred.key],
                        }))
                      }
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-white transition-all"
                    >
                      {shown ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Config fields */}
          {connector.config?.map((cfg) => (
            <div key={cfg.key}>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                {cfg.label}
              </label>
              {cfg.type === "select" && cfg.options ? (
                <select
                  value={configValues[cfg.key] ?? cfg.default ?? ""}
                  onChange={(e) =>
                    setConfigValues((prev) => ({
                      ...prev,
                      [cfg.key]: e.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-surface-3 bg-surface-0 px-3 py-2 text-xs text-white focus:ring-1 focus:ring-brand-500 outline-none transition-all"
                >
                  {cfg.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={configValues[cfg.key] ?? ""}
                  onChange={(e) =>
                    setConfigValues((prev) => ({
                      ...prev,
                      [cfg.key]: e.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-surface-3 bg-surface-0 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:ring-1 focus:ring-brand-500 outline-none transition-all"
                />
              )}
            </div>
          ))}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => {
                // Only send non-empty credential values
                const creds: Record<string, string> = {};
                for (const [k, v] of Object.entries(credValues)) {
                  if (v.trim()) creds[k] = v.trim();
                }
                onSave(creds, configValues);
              }}
              disabled={isSaving}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 disabled:opacity-50 transition-all"
            >
              {isSaving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3 h-3" />
              )}
              Save
            </button>
            <button
              onClick={onTest}
              disabled={isTesting}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-2 border border-surface-3 text-slate-300 text-xs font-medium hover:bg-surface-3 disabled:opacity-50 transition-all"
            >
              {isTesting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Test
            </button>
            {connector.docs_url && (
              <a
                href={connector.docs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-surface-2 transition-all"
                title="Documentation"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>

          {/* Test result */}
          {testResult && !isTesting && (
            <div
              className={cn(
                "flex items-center gap-2 p-2.5 rounded-lg text-xs",
                testResult.ok
                  ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                  : "bg-red-500/10 border border-red-500/20 text-red-400",
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              )}
              <span>{testResult.message}</span>
              {testResult.latency_ms && (
                <span className="text-slate-500 ml-auto">
                  {testResult.latency_ms}ms
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
