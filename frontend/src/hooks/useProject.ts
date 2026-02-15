"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
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

  const getToken = useCallback(async () => {
    if (token) return token;
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token ?? "";
    const uid = data.session?.user?.id ?? null;
    setToken(t);
    setUserId(uid);
    return t;
  }, [token]);

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      await getToken();

      let tid = tenantParam;

      // If no tenant param, resolve by listing tenants via Supabase
      if (!tid) {
        try {
          const tenants = await db.listTenants();
          if (tenants.length > 0) {
            tid = tenants[0].id;
            setResolvedTenantId(tid);
          }
        } catch {
          // DB not ready — load workspace in offline mode
        }
      } else {
        setResolvedTenantId(tid);
      }

      if (!tid) {
        setLoading(false);
        return;
      }

      // Load project and builds via Supabase directly
      try {
        const p = await db.getProject(tid, projectId);
        setProject(p);
      } catch {
        // Project may not exist yet
      }

      try {
        const b = await db.listBuilds(tid, projectId);
        setBuilds(b);
      } catch {
        // No builds yet
      }

      setLoading(false);
    })();
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
