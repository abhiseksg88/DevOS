"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import * as api from "@/lib/api";
import type { Project, Build } from "@/types";

export function useProject(projectId: string) {
  const searchParams = useSearchParams();
  const tenantParam = searchParams.get("tenant") ?? "";
  const [resolvedTenantId, setResolvedTenantId] = useState(tenantParam);
  const [project, setProject] = useState<Project | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);

  const getToken = useCallback(async () => {
    if (token) return token;
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const t = data.session?.access_token ?? "";
    setToken(t);
    return t;
  }, [token]);

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      const t = await getToken();
      if (!t) {
        setLoading(false);
        return;
      }

      let tid = tenantParam;

      // If no tenant param, resolve by listing tenants
      if (!tid) {
        try {
          const tenants = await api.tenants.list(t);
          if (tenants.length > 0) {
            tid = tenants[0].id;
            setResolvedTenantId(tid);
          }
        } catch {
          // Backend not available — load workspace in offline mode
        }
      } else {
        setResolvedTenantId(tid);
      }

      if (!tid) {
        setLoading(false);
        return;
      }

      try {
        const [p, b] = await Promise.all([
          api.projects.get(t, tid, projectId),
          api.builds.list(t, tid, projectId),
        ]);
        setProject(p);
        setBuilds(b);
      } catch {
        // Backend may be offline — workspace still loads
      }
      setLoading(false);
    })();
  }, [tenantParam, projectId, getToken]);

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

  return { project, builds, tenantId: resolvedTenantId, token, loading, createBuild, refreshBuild, getToken };
}
