"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import * as db from "@/lib/supabase-db";
import * as api from "@/lib/api";
import type { Project, Build } from "@/types";

export function useProject(projectId: string) {
  const searchParams = useSearchParams();
  const tenantParam = searchParams.get("tenant") ?? "";
  const [resolvedTenantId, setResolvedTenantId] = useState(tenantParam);
  const [project, setProject] = useState<Project | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [token, setToken] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Use ref to stabilize getToken — prevents effect re-runs when token changes
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // ──────────────────────────────────────────────────────────────
  // Auto-refresh: Listen for Supabase auth state changes
  // (TOKEN_REFRESHED, SIGNED_IN, SIGNED_OUT, etc.)
  // Supabase SDK auto-refreshes the JWT ~30s before it expires,
  // this listener captures the new token so it's never stale.
  // ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const newToken = session?.access_token ?? "";
      const newUserId = session?.user?.id ?? null;
      if (newToken && newToken !== tokenRef.current) {
        setToken(newToken);
        setUserId(newUserId);
        tokenRef.current = newToken;
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // getToken always fetches a fresh session — never returns a stale cached value
  const getToken = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const t = data.session?.access_token ?? "";
      const uid = data.session?.user?.id ?? null;
      setToken(t);
      setUserId(uid);
      tokenRef.current = t;
      return t;
    } catch (err) {
      console.error("[useProject] Failed to get auth session:", err);
      // Return whatever we have cached rather than empty string
      return tokenRef.current || "";
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;

    (async () => {
      try {
        await getToken();
      } catch {
        // Auth not available — continue in offline mode
      }

      if (cancelled) return;

      let tid = tenantParam;

      // ALWAYS validate the tenant via the backend API.
      // The API's list_tenants endpoint filters strictly by tenant_members rows,
      // so it is authoritative regardless of RLS state on the database.
      // The URL ?tenant= param is used only as a preference hint (i.e. which
      // tenant to pick when the user belongs to multiple), NOT as ground truth.
      const currentToken = tokenRef.current;
      if (currentToken) {
        try {
          const apiTenants = await api.tenants.list(currentToken);
          if (!cancelled && apiTenants.length > 0) {
            // If the URL hint points to a tenant the user actually belongs to,
            // keep it. Otherwise fall back to the first valid tenant.
            const hintIsValid = tid && apiTenants.some(t => t.id === tid);
            tid = hintIsValid ? tid : apiTenants[0].id;
            setResolvedTenantId(tid);
          }
        } catch {
          // Backend unreachable — fall back to direct Supabase as last resort.
          // Direct Supabase may return incorrect results if RLS is not fully
          // configured, so only use it when the API is completely unavailable.
          if (!tid) {
            try {
              const tenants = await db.listTenants();
              if (!cancelled && tenants.length > 0) {
                tid = tenants[0].id;
                setResolvedTenantId(tid);
              }
            } catch {
              // DB not ready either — load workspace in offline mode
            }
          } else {
            if (!cancelled) setResolvedTenantId(tid);
          }
        }
      } else {
        // No token yet — use URL param as-is (loading state will protect builds
        // since handleSendMessage guards on !token)
        if (tid && !cancelled) setResolvedTenantId(tid);
      }

      if (!tid) {
        if (!cancelled) setLoading(false);
        return;
      }

      // Load project and builds via Supabase directly
      try {
        const p = await db.getProject(tid, projectId);
        if (!cancelled) setProject(p);
      } catch {
        // Project may not exist yet
      }

      try {
        const b = await db.listBuilds(tid, projectId);
        if (!cancelled) setBuilds(b);
      } catch {
        // No builds yet
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantParam, projectId, getToken]);

  // Build creation still goes through the backend API (needs LLM pipeline)
  const createBuild = useCallback(
    async (prompt: string) => {
      const t = await getToken();
      const build = await api.builds.create(t, resolvedTenantId, projectId, prompt);
      setBuilds((prev) => [build, ...prev]);
      return build;
    },
    [getToken, resolvedTenantId, projectId]
  );

  const refreshBuild = useCallback(
    async (buildId: string) => {
      const t = await getToken();
      const build = await api.builds.get(t, resolvedTenantId, projectId, buildId);
      setBuilds((prev) => prev.map((b) => (b.id === buildId ? build : b)));
      return build;
    },
    [getToken, resolvedTenantId, projectId]
  );

  return { project, builds, tenantId: resolvedTenantId, token, userId, loading, createBuild, refreshBuild, getToken };
}
